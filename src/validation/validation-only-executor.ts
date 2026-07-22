import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { detectPackageValidationCapabilities } from "../implementation/validation-runtime-capabilities.js";
import { runValidation, type CommandDiagnostic } from "../implementation/validation-command-runner.js";
import { blockedRequiredSemanticReview, runSemanticReview, SemanticReviewRequiredError, semanticTaskSpecContext, semanticValidationOutcome, type SemanticReviewResult } from "../implementation/semantic-review.js";
import { compressRawLogs, type LogCompressionInvoker, type LogDigestV1, type RawLogSourceV1 } from "../implementation/raw-log-compressor.js";
import { gateValidationRawLogs } from "../implementation/raw-log-gate.js";
import { assertOpenRouterValidationBudget, invokeOpenRouterSemanticReviewer, openRouterValidationPreCallAllowance, OpenRouterValidationInvocationError, selectOpenRouterSemanticReviewer } from "../implementation/openrouter-executor.js";
import { buildContextPlan } from "../implementation/bounded-context.js";
import { boundedProviderText } from "../implementation/executor-accounting.js";
import { completeExecutionPhase, validationSemanticReviewOptIn, type ExecutionAgreement, type ExecutionPhaseAgreement } from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import { executeOpenRouterChatCompletion, OpenRouterExecutionError } from "../providers/openrouter-execution-provider.js";
import { inspectRepoState, prepareExternalRuntime, type RepoState, type RuntimePreparationResult } from "../run/runtime-preparation.js";
import { createExecutorRequest, DockerShellExecutor } from "../run/task-run-executor.js";
import { copyTaskRunWorkspace, prepareUnpreparedExternalWorkspace } from "../run/task-run-workspace.js";
import {
  aggregateValidationOutcomes, buildMultiLaneValidationPreflightPlan, runtimeCapabilities,
  type ValidationAggregateStatus, type ValidationPreflightPlan,
} from "./capability-contract.js";
import { createGitEvidenceBinding, parseGitEvidenceCommand, type GitEvidenceBinding } from "./git-evidence-lane.js";

const execFileAsync = promisify(execFile);

export type ValidationOnlyExecutorResult = {
  status: "completed" | "failed";
  validationPlan: ValidationPreflightPlan;
  validationAggregate: ValidationAggregateStatus;
  validationResults: CommandDiagnostic[];
  source: { before: RepoState; after: RepoState; unchanged: boolean };
  productWorkspace: string;
  preparation: RuntimePreparationResult | null;
  providerCalls: Array<Record<string, unknown>>;
  usage: { providerCalls: number; totalTokens: number; costUsd: number | null; phases: { reviewer: number; logCompression: number } };
  review: {
    structural: { kind: "structural"; status: ValidationAggregateStatus; evidence: string[] };
    semantic: SemanticReviewResult;
  };
  executionAgreement: ExecutionAgreement;
};

/** Executes read-only TaskSpec validation through the negotiated product and Git-evidence lanes. */
export async function runValidationOnlyExecutor(input: {
  spec: TaskSpecV2;
  executionAgreement: ExecutionAgreement;
  signal?: AbortSignal;
  tempVolume?: string;
  onProgress?: (phase: string, detail: string) => void | Promise<void>;
}): Promise<ValidationOnlyExecutorResult> {
  const { spec } = input;
  if (spec.runtime.preference === "local-disposable") {
    throw new Error("Validation-only execution requires Docker; a disposable local workspace is disabled by external-target policy.");
  }
  const sourceBefore = await inspectRepoState(spec.target.repository);
  const sourceRefsBefore = await sourceRefs(spec.target.repository);
  if (sourceBefore.head !== spec.target.expectedSha) throw new Error(`target_sha_mismatch: expected ${spec.target.expectedSha}, current ${sourceBefore.head}`);
  const workspace = join(dirname(spec.artifacts.root), ".runforge-task-runs", spec.taskId, "validation-workspace");
  await input.onProgress?.("understand_task", "Preparing capability-aware validation lanes.");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(spec.artifacts.root, { recursive: true });

  let preparation: RuntimePreparationResult | null = null;
  let syntheticGitContext = false;
  if (spec.runtime.preference === "docker" && spec.runtime.dependencyPreparation === "required") {
    preparation = await prepareExternalRuntime({ repo: spec.target.repository, workingDirectory: spec.target.workingDirectory, workspace, outDir: spec.artifacts.root, image: spec.runtime.dockerImage });
    await rm(join(workspace, ".git"), { recursive: true, force: true });
    if (spec.validation.profile.id.startsWith("campaign-final-") && /[\\/]campaign-worktrees[\\/]cmp_v1_[^\\/]+(?:[\\/]|$)/.test(spec.target.repository)) {
      await createSyntheticValidationGitContext(resolve(workspace, spec.target.workingDirectory));
      syntheticGitContext = true;
    }
  } else {
    await copyTaskRunWorkspace(spec.target.repository, workspace, "");
    await prepareUnpreparedExternalWorkspace(spec.target.repository, workspace, spec.target.workingDirectory, { taskId: spec.taskId, workspaceId: `validation-${spec.taskId}` });
  }
  const executionRoot = resolve(workspace, spec.target.workingDirectory);
  const sourceDependencies = await access(join(spec.target.repository, spec.target.workingDirectory, "node_modules")).then(() => true, () => false);
  const packageCapabilities = await detectPackageValidationCapabilities({
    commands: spec.validation.commands,
    executionRoot,
    workspaceRoot: workspace,
    commandAvailable: async () => true,
  });
  const productRuntime = runtimeCapabilities({
    runtime: spec.runtime.preference,
    hasGitMetadata: syntheticGitContext,
    packageManager: packageCapabilities.packageManager,
    dependencies: preparation !== null || sourceDependencies || packageCapabilities.dependencies,
    docker: spec.runtime.preference === "docker",
    network: false,
  });

  let gitBinding: GitEvidenceBinding | undefined;
  let gitLaneUnavailableReason: string | undefined;
  try {
    gitBinding = await createGitEvidenceBinding({ targetRepository: spec.target.repository, evidenceWorkspace: spec.target.repository, expectedSha: spec.target.expectedSha });
  } catch (error) {
    gitLaneUnavailableReason = error instanceof Error ? error.message : String(error);
  }
  const validationPlan = buildMultiLaneValidationPreflightPlan({
    requirements: spec.validation.requirements,
    profile: spec.validation.profile,
    policy: spec.validation.projectPolicy,
    productLane: { ...productRuntime, cwd: executionRoot },
    ...(gitBinding ? { gitLane: {
      runtime: "git-evidence", lane: "git-evidence", cwd: gitBinding.cwd,
      available: ["filesystem", "git-read-only-evidence", "git-metadata", "git-history", "working-tree-index", "local-disposable"],
      repositoryIdentity: gitBinding.repositoryIdentity, boundSha: gitBinding.boundSha, safetyAssertions: gitBinding.safetyAssertions,
    } } : {}),
    ...(gitLaneUnavailableReason ? { gitLaneUnavailableReason } : {}),
    parseGit: (command) => {
      const parsed = parseGitEvidenceCommand(command, spec.target.expectedSha);
      return parsed.supported ? { supported: true, argv: parsed.argv, reason: "supported" } : parsed;
    },
  });
  await writeFile(join(spec.artifacts.root, "validation-plan.json"), JSON.stringify(validationPlan, null, 2) + "\n");
  await input.onProgress?.("validate", `Executing ${validationPlan.commands.filter((entry) => entry.disposition === "execute").length} supported validation command(s) across negotiated lanes.`);

  const docker = spec.runtime.preference === "docker"
    ? new DockerShellExecutor(process.cwd(), spec.runtime.dockerImage, true, preparation === null && sourceDependencies ? join(spec.target.repository, spec.target.workingDirectory, "node_modules") : undefined, input.tempVolume)
    : null;
  const validationResults: CommandDiagnostic[] = [];
  for (const [index, entry] of validationPlan.commands.entries()) {
    validationResults.push(await runValidation(
      entry, spec.artifacts.root, 0, index, spec.execution.timeoutMs, input.signal, gitBinding,
      docker ? async (plan, artifactDirectory) => {
        const executed = await docker.execute(createExecutorRequest({
          runId: spec.taskId, subtaskId: `validation-${index + 1}`, command: plan.command,
          cwd: plan.cwd, artifactDir: artifactDirectory, lane: docker.lane, timeoutMs: spec.execution.timeoutMs,
        }));
        return { stdout: executed.stdout, stderr: executed.stderr, exitCode: executed.exitCode, signal: executed.signal, timedOut: executed.timedOut };
      } : undefined,
    ));
  }
  const validationAggregate = aggregateValidationOutcomes(validationResults.map((item) => ({
    command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode,
    reason: item.failureReason, evidenceRole: item.evidenceRole,
  })));
  const semanticPhase = input.executionAgreement.phases.find((phase) => phase.phaseId === "independentReview");
  if (!semanticPhase) throw new Error("Execution Agreement is missing the independentReview phase.");
  const delegation = semanticReviewDelegation(semanticPhase);
  const providerCalls: Array<Record<string, unknown>> = [];
  let agreement = input.executionAgreement;
  let semantic: SemanticReviewResult = {
    kind: "semantic", status: "unavailable", performed: false,
    selectedReviewer: { provider: null, model: null }, reviewer: { provider: null, model: null, invocationId: null },
    confidence: "unknown", limitations: ["Validation-only execution provides structural evidence but does not invoke an independent semantic reviewer."],
    findings: [], evidence: [], delegation,
  };
  const structuralReady = ["passed", "completed_with_validation_gaps"].includes(validationAggregate);
  const semanticOptIn = validationSemanticReviewOptIn(agreement);
  if (structuralReady && semanticOptIn) {
    const rawLogsRequireCompression = validationResults.some((item) => item.outcome !== "passed" && Boolean(item.stdout || item.stderr));
    const selected = selectOpenRouterSemanticReviewer(spec, agreement, rawLogsRequireCompression);
    try {
      if (!selected.selected) throw new Error(selected.reason);
      let digestRef: string | undefined;
      let digest: { summary: string; failureClass: string | null; diagnostics: string[] } | undefined;
      const gate = await gateValidationRawLogs({
        validations: validationResults,
        artifactRoot: spec.artifacts.root,
        iteration: 0,
        compress: async (sources, label) => compressValidationLogs(spec, agreement, sources, label, input.signal, providerCalls),
      });
      if (gate.blocked) throw new Error("raw_log_compression_required");
      assertOpenRouterValidationBudget(spec, providerCalls);
      digestRef = gate.ref; digest = gate.digest;
      const subject = await boundedReviewSubject(spec, executionRoot);
      const review = await runSemanticReview({
        task: spec.task.text, goal: spec.task.goal, acceptanceCriteria: spec.task.acceptanceCriteria,
        changedFiles: subject.files, patch: "", reviewSubject: subject.text, structuralEvidence: validationResults.flatMap((item) => item.artifactPaths),
        taskSpecContext: semanticTaskSpecContext(spec),
        validationOutcomes: validationResults.map((item) => semanticValidationOutcome(item, item.outcome !== "passed" ? digestRef : undefined, digest)),
        knownLimitations: ["Validation-only review inspects bounded existing source; RunForge did not create a patch."],
        independentReview: { executionAgreementId: agreement.agreementId, responsibleParty: "runforge" },
        reviewBudget: { tokenLimit: spec.providerRouting.tokenBudget.perPhase.reviewer, timeoutMs: spec.providerRouting.timeoutMs, deadlineAt: new Date(Date.now() + spec.providerRouting.timeoutMs).toISOString() },
        selectedReviewer: { provider: selected.selected.provider, model: selected.selected.model }, allowed: true,
        invoke: async (prompt) => {
          const invoked = await invokeOpenRouterSemanticReviewer({ spec, agreement, prompt, rawLogsRequireCompression, previousCalls: providerCalls, signal: input.signal });
          const invocationId = invoked.invocationId ?? `semantic-review-${spec.taskId}`;
          const evidence = "provider/semantic-review.json";
          providerCalls.push({ purpose: "semantic-review", phase: "reviewer", provider: invoked.provider, model: invoked.model, invocationId, success: true, providerCalls: true, networkAuthorized: true, exitCode: 0, usageAccounting: "provider", tokenUsage: invoked.usage.totalTokens, inputTokens: invoked.usage.inputTokens, outputTokens: invoked.usage.outputTokens, reasoningTokens: invoked.usage.reasoningTokens, costUsd: invoked.costUsd, attempts: invoked.attempts, artifactPaths: [evidence] });
          await mkdir(join(spec.artifacts.root, "provider"), { recursive: true });
          await writeFile(join(spec.artifacts.root, evidence), JSON.stringify({ provider: invoked.provider, model: invoked.model, invocationId, usage: invoked.usage, costUsd: invoked.costUsd, attempts: invoked.attempts, responseExcerpt: boundedProviderText(invoked.content) }, null, 2) + "\n");
          assertOpenRouterValidationBudget(spec, providerCalls);
          return { provider: invoked.provider, model: invoked.model, invocationId, stdout: invoked.content, stderr: "", evidence: [evidence] };
        },
      });
      semantic = review;
      if (review.status !== "completed" || !providerCalls.some(isBoundSuccessfulReviewerCall)) throw new Error("semantic_review_provider_evidence_missing");
      agreement = completeExecutionPhase(agreement, "independentReview", review.evidence);
      agreement = completeExecutionPhase(agreement, "providerModelCalls", review.evidence);
    } catch (error) {
      if (error instanceof OpenRouterValidationInvocationError && !providerCalls.includes(error.providerCall)) providerCalls.push(error.providerCall);
      semantic = blockedRequiredSemanticReview(new SemanticReviewRequiredError(error instanceof Error ? error.message : String(error)), { provider: selected.selected?.provider ?? null, model: selected.selected?.model ?? null });
    }
  }
  const sourceAfter = await inspectRepoState(spec.target.repository);
  const sourceRefsAfter = await sourceRefs(spec.target.repository);
  const unchanged = sourceBefore.head === sourceAfter.head && sourceBefore.status === sourceAfter.status && sourceRefsBefore === sourceRefsAfter;
  if (!unchanged) throw new Error("source_mutation_detected_during_validation");
  const review = { structural: { kind: "structural" as const, status: validationAggregate, evidence: validationResults.flatMap((item) => item.artifactPaths) }, semantic };
  const completed = structuralReady && (!semanticOptIn || semantic.status === "completed");
  const costs = providerCalls.flatMap((call) => typeof call.costUsd === "number" ? [call.costUsd] : []);
  return { status: completed ? "completed" : "failed", validationPlan, validationAggregate, validationResults, source: { before: sourceBefore, after: sourceAfter, unchanged }, productWorkspace: workspace, preparation, providerCalls, usage: { providerCalls: providerCalls.length, totalTokens: providerCalls.reduce((sum, call) => sum + (typeof call.tokenUsage === "number" ? call.tokenUsage : 0), 0), costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, phases: { reviewer: providerCalls.filter((call) => call.phase === "reviewer").length, logCompression: providerCalls.filter((call) => call.phase === "logCompression").length } }, review, executionAgreement: agreement };
}

async function compressValidationLogs(spec: TaskSpecV2, agreement: ExecutionAgreement, sources: RawLogSourceV1[], label: string, signal: AbortSignal | undefined, providerCalls: Array<Record<string, unknown>>): Promise<{ digest: LogDigestV1; ref: string }> {
  const selected = selectOpenRouterSemanticReviewer(spec, agreement, true);
  if (!selected.selected?.logCompressionModel) throw new Error(selected.reason);
  const invoke: LogCompressionInvoker = async ({ prompt }) => {
    const allowance = openRouterValidationPreCallAllowance({ spec, calls: providerCalls, phase: "logCompression", prompt });
    let response: Awaited<ReturnType<typeof executeOpenRouterChatCompletion>>;
    try {
      response = await executeOpenRouterChatCompletion({ model: selected.selected!.logCompressionModel!, messages: [{ role: "system", content: "Return only the requested structured raw-log digest. Do not call tools or include raw logs beyond the supplied sanitized chunks." }, { role: "user", content: prompt }], timeoutMs: spec.providerRouting.timeoutMs, maxCalls: allowance.maxAttempts, maxTokens: allowance.maxTokens, signal });
    } catch (error) {
      const failure = error instanceof OpenRouterExecutionError ? error : null, usage = failure?.options.usage;
      const failedCall = { purpose: "raw-log-compression", phase: "logCompression", provider: "openrouter", model: selected.selected!.logCompressionModel, invocationId: failure?.options.requestId ?? null, success: false, providerCalls: true, networkAuthorized: true, exitCode: 1, usageAccounting: "provider", tokenUsage: usage?.totalTokens ?? null, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, costUsd: usage?.costUsd ?? null, attempts: Math.max(1, failure?.options.attempts ?? 1), status: failure?.options.status ?? null, failureReason: failure?.code ?? "provider" };
      providerCalls.push(failedCall);
      const ref = `provider/log-compression-failure-${label}.json`;
      await mkdir(join(spec.artifacts.root, "provider"), { recursive: true });
      await writeFile(join(spec.artifacts.root, ref), JSON.stringify({ ...failedCall, error: boundedProviderText(error instanceof Error ? error.message : String(error)) }, null, 2) + "\n");
      throw error;
    }
    providerCalls.push({ purpose: "raw-log-compression", phase: "logCompression", provider: "openrouter", model: selected.selected!.logCompressionModel, invocationId: response.requestId, success: true, providerCalls: true, networkAuthorized: true, exitCode: 0, usageAccounting: "provider", tokenUsage: response.usage.totalTokens, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reasoningTokens: response.usage.reasoningTokens, costUsd: response.usage.costUsd, attempts: response.attempts });
    assertOpenRouterValidationBudget(spec, providerCalls);
    return { content: response.content, model: selected.selected!.logCompressionModel!, requestId: response.requestId, tokenUsage: response.usage.totalTokens, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reasoningTokens: response.usage.reasoningTokens, costUsd: response.usage.costUsd, attempts: response.attempts };
  };
  const result = await compressRawLogs({ sources, invoke });
  const ref = `provider/log-digest-${label}.json`;
  await mkdir(join(spec.artifacts.root, "provider"), { recursive: true });
  await writeFile(join(spec.artifacts.root, ref), JSON.stringify({ digest: result.digest, rawDigestMetadata: result.rawDigestMetadata, model: result.model, requestId: result.requestId }, null, 2) + "\n");
  return { digest: result.digest, ref };
}

async function boundedReviewSubject(spec: TaskSpecV2, executionRoot: string): Promise<{ files: string[]; text: string }> {
  const context = await buildContextPlan({ spec } as never, executionRoot);
  const reads = Array.isArray(context.plan.reads) ? context.plan.reads as Array<Record<string, unknown>> : [];
  const files = reads.filter((item) => item.status === "planned" && typeof item.file === "string").map((item) => item.file as string);
  if (context.plan.withinBounds !== true || files.length === 0 || !context.prompt.trim()) throw new Error("semantic_review_subject_unavailable:no accepted reviewable source within bounded context");
  return { files, text: context.prompt };
}

function isBoundSuccessfulReviewerCall(call: Record<string, unknown>): boolean {
  return call.purpose === "semantic-review" && call.phase === "reviewer" && call.provider === "openrouter"
    && typeof call.model === "string" && Boolean(call.model) && typeof call.invocationId === "string" && Boolean(call.invocationId)
    && call.success === true && call.providerCalls === true && call.networkAuthorized === true && call.exitCode === 0;
}

/** Includes all ref names and object IDs, so a review adapter cannot quietly move a source ref. */
async function sourceRefs(repository: string): Promise<string> {
  return (await execFileAsync("git", ["-C", repository, "for-each-ref", "--format=%(refname) %(objectname)"], { maxBuffer: 2_000_000 })).stdout.trim();
}

/** Creates non-authoritative Git context inside a disposable validation snapshot. */
export async function createSyntheticValidationGitContext(workspace: string): Promise<void> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_OPTIONAL_LOCKS: "0" };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workspace, env, maxBuffer: 2_000_000 });
  await git(["init", "--quiet", "--initial-branch=runforge-validation-snapshot"]);
  await git(["config", "user.name", "RunForge Validation Snapshot"]);
  await git(["config", "user.email", "validation-snapshot@runforge.invalid"]);
  await git(["config", "core.hooksPath", "/dev/null"]);
  await git(["config", "credential.helper", ""]);
  await git(["config", "protocol.file.allow", "never"]);
  await writeFile(join(workspace, ".git", "info", "exclude"), ["**/node_modules/", "**/.runforge-corepack/", "**/.runforge-tmp/", ""].join("\n"), "utf8");
  await git(["add", "--all"]);
  await git(["commit", "--quiet", "--no-verify", "--message", "RunForge disposable validation snapshot"]);
}

function semanticReviewDelegation(phase: ExecutionPhaseAgreement): NonNullable<SemanticReviewResult["delegation"]> {
  const effectiveDecision = `Execution Agreement marks independentReview as ${phase.status} with responsibleParty ${phase.responsibleParty}: ${phase.reason}`;
  if (!phase.requested || phase.responsibleParty === "nobody" || phase.status === "not_requested") {
    return {
      party: "external_session",
      reason: `${effectiveDecision} Validation-only mode made no provider invocation.`,
      exactAction: "In external_session, request and perform an independent semantic review, then attach structured findings to this handoff.",
    };
  }
  if (phase.responsibleParty === "owner" || phase.responsibleParty === "external_session" || phase.responsibleParty === "external_system") {
    return {
      party: phase.responsibleParty,
      reason: `${effectiveDecision} Validation-only mode made no provider invocation.`,
      exactAction: `Have ${phase.responsibleParty} perform the requested independent semantic review and attach structured findings to this handoff.`,
    };
  }
  return {
    party: "external_session",
    reason: `${effectiveDecision} Validation-only mode made no provider invocation, so the review remains outstanding.`,
    exactAction: "In external_session, arrange the outstanding independent semantic review and attach structured findings to this handoff.",
  };
}
