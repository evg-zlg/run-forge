import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadAdminConfig } from "../admin/config.js";
import { scanSecrets } from "../security/secret-scan.js";
import type { TaskSpecV2, TaskExecutionMode } from "../product/task-spec-v2.js";
import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor } from "../product/task-spec-contract.js";
import { persistDurableCheckpoint } from "./durable-checkpoint.js";
import { executionPhaseOwner } from "../product/execution-agreement.js";
import {
  aggregateValidationOutcomes, buildMultiLaneValidationPreflightPlan, runtimeCapabilities,
  type ValidationAggregateStatus, type ValidationPreflightPlan,
} from "../validation/capability-contract.js";
import { createGitEvidenceBinding, parseGitEvidenceCommand } from "../validation/git-evidence-lane.js";
import { detectPackageValidationCapabilities } from "./validation-runtime-capabilities.js";
import { runValidation, type CommandDiagnostic } from "./validation-command-runner.js";
import { runSemanticReview, semanticReviewBudgetOverrun, semanticReviewPhaseTimeoutMs, semanticTaskSpecContext, semanticValidationOutcome, uniqueReviewLimitations, type SemanticReviewResult } from "./semantic-review.js";

const execFileAsync = promisify(execFile);
const credentialCache = new Map<string, { at: number; ready: boolean }>();
export type ExecutorStatus = "ready" | "degraded" | "unavailable";
export type ImplementationExecutorCapability = {
  id: string; status: ExecutorStatus; supports: TaskExecutionMode[]; providerCalls: boolean;
  runtime: string[]; providerRequirements: string[]; networkRequirements: string[];
  maxLimits: { timeoutMs: number; repairIterations: number; changedFiles: number; patchBytes: number; providerTokens: number };
  limitations: string[]; command: string | null; model: string | null;
};
export type { CommandDiagnostic } from "./validation-command-runner.js";
export type ImplementationExecutorRequest = {
  spec: TaskSpecV2; targetRepository: string; workingDirectory: string; projectProfile: Record<string, unknown>;
  acceptanceCriteria: string[]; authorityEnvelope: TaskSpecV2["authority"]; forbiddenZones: string[];
  runtimePolicy: TaskSpecV2["runtime"]; validationProfile: TaskSpecV2["validation"]; artifactRoot: string;
  attempt: number; generation: string; signal?: AbortSignal; onProgress?: (phase: string, detail: string) => void | Promise<void>;
  executionAgreementId: string;
  checkpointRepair?: { patchPath: string; checkpointId: string; checkpointDigest: string; repairIntent: string | null };
};
export type ImplementationExecutorResult = {
  plan: string[]; changedFiles: string[]; patch: string; validationResults: CommandDiagnostic[];
  validationPlan: ValidationPreflightPlan; validationAggregate: ValidationAggregateStatus;
  unresolvedFindings: string[]; status: "implemented_and_validated" | "no_change_required" | "blocked_with_owner_gate" | "failed_with_diagnostics";
  ownerGate: { required: boolean; reason: string | null }; safetyAssertions: Record<string, boolean>;
  diagnostics: Record<string, unknown>; localBranch: string | null; localCommit: string | null; patchPackage: string | null;
  providerCalls: Array<Record<string, unknown>>; selectedExecutor: { id: string; model: string | null };
  review: { structural: { kind: "structural"; status: ValidationAggregateStatus; evidence: string[] }; semantic: SemanticReviewResult };
  checkpoints: Array<{ id: string; path: string; patchPath: string; digest: string; iteration: number; validationPassed: boolean }>;
  budget: { exceeded: boolean; overrunPhase: "implementation" | "repair" | "review" | null; requestedTokens: number; actualTokens: number; accounting: "provider" | "synthetic"; costUsd: null };
};

export async function discoverImplementationExecutors(): Promise<ImplementationExecutorCapability[]> {
  const configured = await configuredCommand();
  if (!configured) return [capability(null, "unavailable", ["No coding-agent CLI was found. Install/configure codex-cli or set RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND."])];
  const argv = splitCommand(configured.command);
  if (!argv.length || !(await executableAvailable(argv[0]!))) return [capability(configured.command, "unavailable", [`Executor command is unavailable: ${argv[0] ?? "empty"}.`], configured.model)];
  if (/(?:^|\/)codex$/.test(argv[0]!) && !(await codexCredentialReady(argv))) return [capability(configured.command, "unavailable", ["Codex CLI credential status is unavailable; authenticate through the existing local credential mechanism."], configured.model)];
  return [capability(configured.command, "ready", [], configured.model)];
}

export async function selectImplementationExecutor(spec: TaskSpecV2): Promise<{ selected: ImplementationExecutorCapability | null; reason: string; rejected: Array<{ id: string; reason: string }> }> {
  const executors = await discoverImplementationExecutors();
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const executor of executors) {
    const reasons: string[] = [];
    if (executor.status !== "ready") reasons.push(...executor.limitations);
    if (!executor.supports.includes(spec.execution.mode)) reasons.push(`mode ${spec.execution.mode} is unsupported`);
    if (!runtimeCompatibleWithImplementationExecutor(spec.runtime.preference)) reasons.push(`runtime ${spec.runtime.preference} is unsupported; ${executor.id} accepts: ${executor.runtime.join(", ")}`);
    if (spec.execution.maxProviderTokens > executor.maxLimits.providerTokens) reasons.push(`provider token budget exceeds executor limit ${executor.maxLimits.providerTokens}`);
    if (executor.providerCalls && !spec.authority.allowProviderCalls) reasons.push("provider calls denied by TaskSpec authority");
    if (executor.providerCalls && (!spec.authority.allowNetwork || spec.runtime.externalNetwork !== "allowed")) reasons.push("provider network denied by TaskSpec authority/runtime policy");
    if (reasons.length) { rejected.push({ id: executor.id, reason: reasons.join("; ") }); continue; }
    return { selected: executor, reason: `Deterministic policy selected the first ready executor supporting ${spec.execution.mode}, local disposable runtime, provider and network authority, and requested limits.`, rejected };
  }
  return { selected: null, reason: "No compatible ready implementation executor.", rejected };
}

export async function runImplementationExecutor(request: ImplementationExecutorRequest): Promise<ImplementationExecutorResult> {
  const selection = await selectImplementationExecutor(request.spec);
  if (!selection.selected?.command) throw new Error(`executor_unavailable: ${selection.reason} ${selection.rejected.map((item) => `${item.id}: ${item.reason}`).join("; ")}`);
  const executor = selection.selected;
  const executorCommand = executor.command!;
  const sourceBefore = await git(request.targetRepository, ["rev-parse", "HEAD"]);
  if (sourceBefore.trim() !== request.spec.target.expectedSha) throw new Error(`target_sha_mismatch: expected ${request.spec.target.expectedSha}, current ${sourceBefore.trim()}`);
  const sourceStatusBefore = await git(request.targetRepository, ["status", "--porcelain=v1"]);
  const dirtyPolicy = request.spec.target.dirtyPolicy ?? "use_disposable_from_base_sha";
  if (sourceStatusBefore.trim() && (dirtyPolicy === "require_clean" || dirtyPolicy === "allow_known_generated" && unsafeDirtyLines(sourceStatusBefore).length)) throw new Error(`active_human_work_conflict: dirtyPolicy=${dirtyPolicy} preserved existing changes.`);
  const workspace = join(dirname(request.artifactRoot), "workspace");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(dirname(workspace), { recursive: true });
  await progress(request, "understand_task", "Task, acceptance criteria, authority and forbidden zones normalized.");
  const branchOwnedByRunForge = executionPhaseOwner(
    request.spec.executionAgreement.profile,
    "localBranch",
    request.spec.executionAgreement.phaseOwnership,
  ) === "runforge";
  const commitOwnedByRunForge = executionPhaseOwner(
    request.spec.executionAgreement.profile,
    "localCommit",
    request.spec.executionAgreement.phaseOwnership,
  ) === "runforge";
  const localBranch = branchOwnedByRunForge ? localBranchName(request.spec.taskId, request.generation, request.attempt) : null;
  if (localBranch && await localRefExists(request.targetRepository, localBranch)) {
    throw new Error(`local_branch_collision: refusing to overwrite refs/heads/${localBranch}`);
  }
  await git(request.targetRepository, localBranch
    ? ["worktree", "add", "-b", localBranch, workspace, request.spec.target.expectedSha]
    : ["worktree", "add", "--detach", workspace, request.spec.target.expectedSha]);
  const executionRoot = resolve(workspace, request.workingDirectory);
  if (!isInside(workspace, executionRoot)) throw new Error("working_directory_escape");
  if (request.checkpointRepair) {
    await progress(request, "repair", `Restoring verified checkpoint ${request.checkpointRepair.checkpointId} into a disposable workspace.`);
    await git(workspace, ["apply", "--index", "--binary", request.checkpointRepair.patchPath]);
  }
  const plan = ["Inspect the target and acceptance criteria", "Implement only bounded changes in the disposable worktree", "Run declared validation", "Repair in-scope failures within the iteration budget", "Finalize patch/commit evidence without publication"];
  const contextPlan = await buildContextPlan(request, executionRoot);
  await mkdir(request.artifactRoot, { recursive: true });
  await writeFile(join(request.artifactRoot, "implementation-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  await writeFile(join(request.artifactRoot, "context-plan.json"), JSON.stringify(contextPlan, null, 2) + "\n");
  const hasGitMetadata = await pathAvailable(join(workspace, ".git"));
  const packageCapabilities = await detectPackageValidationCapabilities({
    commands: request.validationProfile.commands, executionRoot, workspaceRoot: workspace,
  });
  const detectedRuntime = runtimeCapabilities({
    runtime: "local-disposable", hasGitMetadata: false,
    packageManager: packageCapabilities.packageManager, dependencies: packageCapabilities.dependencies,
    network: request.runtimePolicy.externalNetwork === "allowed",
    providerModel: request.authorityEnvelope.allowProviderCalls,
  });
  let gitBinding;
  let gitLaneUnavailableReason: string | undefined;
  if (hasGitMetadata) {
    try {
      gitBinding = await createGitEvidenceBinding({ targetRepository: request.targetRepository, evidenceWorkspace: workspace, expectedSha: request.spec.target.expectedSha });
    } catch (error) {
      gitLaneUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  } else {
    gitLaneUnavailableReason = "A separate Git evidence lane with repository metadata is unavailable.";
  }
  const validationPlan = buildMultiLaneValidationPreflightPlan({
    requirements: request.validationProfile.requirements, profile: request.validationProfile.profile, policy: request.validationProfile.projectPolicy,
    productLane: { ...detectedRuntime, cwd: executionRoot },
    ...(gitBinding ? { gitLane: {
      runtime: "git-evidence", lane: "git-evidence", cwd: workspace,
      available: ["filesystem", "git-read-only-evidence", "git-metadata", "git-history", "working-tree-index", "local-disposable"],
      repositoryIdentity: gitBinding.repositoryIdentity, boundSha: gitBinding.boundSha, safetyAssertions: gitBinding.safetyAssertions,
    } } : {}),
    ...(gitLaneUnavailableReason ? { gitLaneUnavailableReason } : {}),
    parseGit: (command) => {
      const parsed = parseGitEvidenceCommand(command, request.spec.target.expectedSha);
      return parsed.supported ? { supported: true, argv: parsed.argv, reason: "supported" } : parsed;
    },
  });
  await writeFile(join(request.artifactRoot, "validation-plan.json"), JSON.stringify(validationPlan, null, 2) + "\n");
  const providerCalls: Array<Record<string, unknown>> = [];
  const checkpoints: ImplementationExecutorResult["checkpoints"] = [];
  const validations: CommandDiagnostic[] = request.checkpointRepair
    ? JSON.parse(await readFile(join(dirname(request.checkpointRepair.patchPath), "validation.json"), "utf8")) as CommandDiagnostic[]
    : [];
  let agentSummary = "";
  let status: ImplementationExecutorResult["status"] = "failed_with_diagnostics";
  let unresolved: string[] = [];
  let patch = "";
  let changedFiles: string[] = [];
  let localCommit: string | null = null;
  let budgetExceeded = false;
  let overrunPhase: ImplementationExecutorResult["budget"]["overrunPhase"] = null;
  let overrunActual = 0, overrunLimit = request.spec.execution.maxProviderTokens;
  let semanticReview: SemanticReviewResult = { kind: "semantic", status: "forbidden", performed: false, selectedReviewer: { provider: null, model: null }, reviewer: { provider: null, model: null, invocationId: null }, confidence: "unknown", limitations: ["Semantic review has not been reached."], findings: [], evidence: [], delegation: { party: "external_session", reason: "Semantic review has not been reached.", exactAction: "Perform an independent semantic review and attach structured findings." } };
  try {
    const firstIteration = request.checkpointRepair ? 1 : 0;
    for (let iteration = firstIteration; iteration <= request.spec.execution.maxRepairIterations; iteration += 1) {
      const phase = iteration === 0 ? "implement" : "repair";
      await progress(request, phase, iteration === 0 ? "Coding executor is implementing the bounded task." : `Repair iteration ${iteration} is addressing validation failures.`);
      const prompt = buildPrompt(request, iteration, validations);
      const call = await runAgent(executorCommand, executor.model, executionRoot, prompt, request.spec.execution.timeoutMs, request.signal, request.artifactRoot, iteration);
      providerCalls.push({ command: "local-coding-agent", cwd: executionRoot, executor: executor.id, runtime: "local-disposable", executorId: executor.id, model: executor.model, providerCalls: true, networkAuthorized: true, usageAccounting: process.env.RUNFORGE_USAGE_ACCOUNTING === "synthetic" ? "synthetic" : "provider", iteration, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, exitCode: call.exitCode, signal: call.signal, timedOut: call.timedOut, stdout: call.stdout, stderr: call.stderr, truncation: call.truncation, artifactPaths: [call.stdoutArtifact, call.stderrArtifact], failureReason: call.failureReason, classification: call.exitCode === 0 ? null : "provider", diagnosticGap: call.exitCode !== 0 && !call.stdout.trim() && !call.stderr.trim(), tokenUsage: call.tokenUsage, tokenBudget: request.spec.execution.maxProviderTokens, stdoutArtifact: call.stdoutArtifact, stderrArtifact: call.stderrArtifact });
      agentSummary = call.summary;
      if (call.cancelled) throw new Error("cancelled");
      if (call.exitCode !== 0) { unresolved = [`Coding agent failed with exit ${call.exitCode ?? "signal"}.`]; break; }
      await git(workspace, ["add", "-N", "."]);
      patch = await git(workspace, ["diff", "--binary", "--no-ext-diff", request.spec.target.expectedSha]);
      changedFiles = lines(await git(workspace, ["diff", "--name-only", request.spec.target.expectedSha]));
      if (!changedFiles.length) {
        const ambiguous = /ambiguous|clarif|product decision|cannot determine/i.test(agentSummary);
        status = ambiguous ? "blocked_with_owner_gate" : /no change|required|already (?:correct|fixed)|false positive/i.test(agentSummary) ? "no_change_required" : "failed_with_diagnostics";
        unresolved = ambiguous ? ["New product semantics or clarification is required."] : status === "no_change_required" ? [] : ["Implementation executor produced no change and did not establish no_change_required."];
        break;
      }
      const safetyErrors = validateChangedPaths(changedFiles, request.forbiddenZones, request.spec.execution.maxChangedFiles);
      if (Buffer.byteLength(patch) > request.spec.execution.maxPatchBytes) safetyErrors.push(`Patch exceeds ${request.spec.execution.maxPatchBytes} bytes.`);
      const secretScan = scanSecrets(addedPatchLines(patch));
      if (secretScan.status === "failed") safetyErrors.push("Secret scan rejected the patch.");
      if (safetyErrors.length) { unresolved = safetyErrors; status = "blocked_with_owner_gate"; }
      await progress(request, "validate", `Running ${request.validationProfile.commands.length} validation command(s).`);
      validations.splice(0, validations.length);
      if (!safetyErrors.length) for (let index = 0; index < validationPlan.commands.length; index += 1) validations.push(await runValidation(validationPlan.commands[index]!, request.artifactRoot, iteration, index, request.spec.execution.timeoutMs, request.signal, gitBinding));
      const validationAggregate = aggregateValidationOutcomes(validations.map((item) => ({ command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode, reason: item.failureReason, evidenceRole: item.evidenceRole })));
      const validationPassed = !safetyErrors.length && ["passed", "completed_with_validation_gaps"].includes(validationAggregate);
      if (!validationPassed && !safetyErrors.length) unresolved = validations.filter((item) => item.outcome !== "passed").map((item) => `${item.command}: ${item.outcome}${item.infrastructureDefect ? ` (${item.infrastructureDefect})` : ""}`);
      const actualTokens = providerCalls.reduce((sum, item) => sum + (typeof item.tokenUsage === "number" ? item.tokenUsage : 0), 0);
      const phaseLimit = request.spec.execution.phaseBudgets[iteration === 0 ? "implementation" : "repair"];
      const checkpoint = await persistDurableCheckpoint(request.artifactRoot, {
        taskId: request.spec.taskId, executionAgreementId: request.executionAgreementId,
        checkpointId: `${iteration === 0 ? "implementation" : "repair"}-${iteration}`,
        iteration, kind: iteration === 0 ? "implementation" : "repair", baseSha: request.spec.target.expectedSha,
        workspaceSha: null, workspaceState: "dirty", patch, changedFiles, validation: validations,
        usage: { accounting: providerCalls.at(-1)?.usageAccounting ?? "provider", phase, providerCalls: providerCalls.length, totalTokens: actualTokens, costUsd: null },
        executor: { id: executor.id, model: executor.model, runtime: "local-disposable", attempt: request.attempt, generation: request.generation },
        safetyAssertions: { targetMainMutation: false, targetMainPush: false, forbiddenZonesRespected: safetyErrors.length === 0, secretScanPassed: !safetyErrors.includes("Secret scan rejected the patch.") },
        unresolvedFindings: unresolved
      });
      checkpoints.push({ id: checkpoint.id, path: relative(request.artifactRoot, checkpoint.path), patchPath: relative(request.artifactRoot, checkpoint.patchPath), digest: checkpoint.digest, iteration, validationPassed });
      const phaseExceeded = (call.tokenUsage ?? 0) > phaseLimit, totalExceeded = actualTokens > request.spec.execution.maxProviderTokens;
      budgetExceeded = totalExceeded || phaseExceeded;
      if (budgetExceeded) { overrunPhase = phase === "implement" ? "implementation" : "repair"; overrunActual = phaseExceeded ? call.tokenUsage ?? 0 : actualTokens; overrunLimit = phaseExceeded ? phaseLimit : request.spec.execution.maxProviderTokens; }
      if (safetyErrors.length) { status = "blocked_with_owner_gate"; break; }
      if (validationPassed) {
        const reviewOwner = executionPhaseOwner(request.spec.executionAgreement.profile, "independentReview", request.spec.executionAgreement.phaseOwnership);
        const reviewTimeoutMs = semanticReviewPhaseTimeoutMs(request.spec.execution.timeoutMs, request.spec.execution.phaseBudgets.review, request.spec.execution.maxProviderTokens);
        const reviewDeadlineAt = new Date(Date.now() + reviewTimeoutMs).toISOString(), selectedReviewer = reviewOwner === "runforge" ? { provider: executor.id, model: executor.model } : { provider: null, model: null };
        semanticReview = await runSemanticReview({
          task: request.spec.task.text, goal: request.spec.task.goal, acceptanceCriteria: request.acceptanceCriteria,
          changedFiles, patch, structuralEvidence: validations.flatMap((item) => item.artifactPaths),
          taskSpecContext: semanticTaskSpecContext(request.spec),
          validationOutcomes: validations.map(semanticValidationOutcome),
          knownLimitations: uniqueReviewLimitations([...unresolved, ...validations.filter((item) => item.outcome !== "passed").map((item) => `${item.command}: ${item.outcome}${item.failureReason ? ` (${item.failureReason})` : ""}`)]),
          independentReview: { executionAgreementId: request.executionAgreementId, responsibleParty: reviewOwner },
          validatedCheckpoint: { id: checkpoint.id, digest: checkpoint.digest, path: relative(request.artifactRoot, checkpoint.path) },
          reviewBudget: { tokenLimit: request.spec.execution.phaseBudgets.review, timeoutMs: reviewTimeoutMs, deadlineAt: reviewDeadlineAt },
          selectedReviewer,
          allowed: !budgetExceeded && request.spec.execution.phaseBudgets.review > 0 && reviewOwner === "runforge" && request.authorityEnvelope.allowProviderCalls && request.authorityEnvelope.allowNetwork,
          delegatedParty: budgetExceeded || reviewOwner === "owner" ? "owner" : "external_session",
          invoke: async (reviewPrompt) => {
            await progress(request, "review", "Invoking the independent semantic reviewer after structural validation.");
            const call = await runAgent(executorCommand, executor.model, executionRoot, reviewPrompt, reviewTimeoutMs, request.signal, request.artifactRoot, "semantic-review");
            const invocationId = `semantic-review-${iteration}`;
            providerCalls.push({ command: "local-coding-agent", purpose: "semantic-review", invocationId, cwd: executionRoot, executor: executor.id, runtime: "local-disposable", executorId: executor.id, model: executor.model, providerCalls: true, networkAuthorized: true, usageAccounting: process.env.RUNFORGE_USAGE_ACCOUNTING === "synthetic" ? "synthetic" : "provider", iteration, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, exitCode: call.exitCode, signal: call.signal, timedOut: call.timedOut, stdout: call.stdout, stderr: call.stderr, truncation: call.truncation, artifactPaths: [call.stdoutArtifact, call.stderrArtifact], failureReason: call.failureReason, classification: call.exitCode === 0 ? null : "provider", tokenUsage: call.tokenUsage, tokenBudget: request.spec.execution.phaseBudgets.review, timeoutMs: reviewTimeoutMs, deadlineAt: reviewDeadlineAt, validatedCheckpointId: checkpoint.id, stdoutArtifact: call.stdoutArtifact, stderrArtifact: call.stderrArtifact });
            if (call.exitCode !== 0) throw new Error(call.failureReason ?? `reviewer exited ${call.exitCode ?? "by signal"}`);
            return { provider: executor.id, model: executor.model, invocationId, stdout: call.stdout, stderr: call.stderr, evidence: [call.stdoutArtifact, call.stderrArtifact] };
          },
        });
        const reviewOverrun = semanticReviewBudgetOverrun(providerCalls, request.spec.execution.phaseBudgets.review, request.spec.execution.maxProviderTokens);
        if (reviewOverrun) { budgetExceeded = true; overrunPhase = "review"; overrunActual = reviewOverrun.actual; overrunLimit = reviewOverrun.limit; }
        status = "implemented_and_validated";
        if (semanticReview.findings.some((finding) => finding.blocking)) unresolved = semanticReview.findings.filter((finding) => finding.blocking).map((finding) => `${finding.severity} ${finding.file}:${finding.location} ${finding.category}: ${finding.recommendation}`);
        break;
      }
      if (validationAggregate !== "product_failed") { status = "failed_with_diagnostics"; break; }
      if (budgetExceeded) { status = "blocked_with_owner_gate"; break; }
    }
    if (status === "implemented_and_validated" || status === "no_change_required") {
      if (commitOwnedByRunForge) {
        await progress(request, "finalize", "Creating the RunForge-owned local commit and patch package; publication remains on hold.");
        await git(workspace, ["add", "-A"]);
        await git(workspace, ["-c", "user.name=RunForge Executor", "-c", "user.email=runforge@localhost", "commit", ...(status === "no_change_required" ? ["--allow-empty"] : []), "-m", `RunForge ${request.spec.taskId}`]);
        localCommit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
        patch = await git(workspace, ["format-patch", "-1", "--stdout", localCommit]);
        changedFiles = lines(await git(workspace, ["diff-tree", "--no-commit-id", "--name-only", "-r", localCommit]));
      } else {
        await progress(request, "finalize", "Preserving the validated binary diff without creating an externally owned commit.");
      }
    }
    const patchPackage = patch ? join(request.artifactRoot, "implementation.patch") : null;
    if (patchPackage) await writeFile(patchPackage, patch, "utf8");
    const sourceAfter = (await git(request.targetRepository, ["rev-parse", "HEAD"])).trim();
    const sourceStatusAfter = await git(request.targetRepository, ["status", "--porcelain=v1"]);
    return {
      plan, changedFiles, patch, validationResults: validations, validationPlan,
      validationAggregate: aggregateValidationOutcomes(validations.map((item) => ({ command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode, reason: item.failureReason, evidenceRole: item.evidenceRole }))),
      unresolvedFindings: unresolved, status,
      ownerGate: { required: status === "blocked_with_owner_gate" || budgetExceeded || semanticReview.findings.some((finding) => finding.blocking), reason: budgetExceeded ? `Provider token budget exceeded after durable checkpoint in ${overrunPhase}: ${overrunActual} > ${overrunLimit}.` : unresolved.length ? unresolved.join(" ") : null },
      safetyAssertions: { sourceShaUnchanged: sourceAfter === sourceBefore.trim(), sourceWorktreeStateUnchanged: sourceStatusAfter === sourceStatusBefore, targetMainMutation: false, targetMainPush: false, merge: false, deploy: false, publicationPerformed: false, forbiddenZonesRespected: !unresolved.some((item) => item.includes("forbidden")), secretScanPassed: !unresolved.includes("Secret scan rejected the patch.") },
      diagnostics: { agentSummary, sourceBefore: sourceBefore.trim(), sourceAfter, sourceWorktreeStatusBefore: sourceStatusBefore, sourceWorktreeStatusAfter: sourceStatusAfter, dirtyPolicy, contextPlan, selectionReason: selection.reason, rejectedAlternatives: selection.rejected, workspace: relative(request.targetRepository, workspace), ...(request.checkpointRepair ? { checkpointRepair: { sourceCheckpointId: request.checkpointRepair.checkpointId, sourceCheckpointDigest: request.checkpointRepair.checkpointDigest, sourcePatch: request.checkpointRepair.patchPath, restoredOnBaseSha: request.spec.target.expectedSha, disposableWorkspace: true } } : {}) },
      localBranch, localCommit, patchPackage, providerCalls, checkpoints,
      review: { structural: { kind: "structural", status: aggregateValidationOutcomes(validations.map((item) => ({ command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode, reason: item.failureReason, evidenceRole: item.evidenceRole }))), evidence: validations.flatMap((item) => item.artifactPaths) }, semantic: semanticReview },
      budget: { exceeded: budgetExceeded, overrunPhase, requestedTokens: request.spec.execution.maxProviderTokens, actualTokens: providerCalls.reduce((sum, item) => sum + (typeof item.tokenUsage === "number" ? item.tokenUsage : 0), 0), accounting: providerCalls.some((item) => item.usageAccounting === "synthetic") ? "synthetic" : "provider", costUsd: null },
      selectedExecutor: { id: executor.id, model: executor.model }
    };
  } finally {
    await git(request.targetRepository, ["worktree", "remove", "--force", workspace]).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}
function capability(command: string | null, status: ExecutorStatus, limitations: string[], model: string | null = process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null): ImplementationExecutorCapability { const result = { id: implementationExecutorContract.id, status, supports: [...implementationExecutorContract.modes], providerCalls: true, runtime: [...implementationExecutorContract.runtimes], providerRequirements: ["existing local coding-agent credential mechanism"], networkRequirements: ["provider transport; denied unless separately authorized"], maxLimits: implementationExecutorContract.maxLimits, limitations, model } as ImplementationExecutorCapability; Object.defineProperty(result, "command", { value: command, enumerable: false }); return result; }
async function configuredCommand(): Promise<{ command: string; model: string | null } | null> { const env = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND?.trim(); if (env) return { command: env, model: process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null }; const config = await loadAdminConfig(); const provider = config.config.providers.find((item) => item.id === "codex-cli" && item.type === "cli" && item.enabled && item.command); if (provider?.command) return { command: provider.command, model: provider.defaultModel ?? null }; return executableAvailable("codex").then((ready) => ready ? { command: "codex", model: process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null } : null); }
async function executableAvailable(command: string): Promise<boolean> { if (command.includes("/")) return access(command).then(() => true, () => false); return execFileAsync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]).then(() => true, () => false); }
async function pathAvailable(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
async function codexCredentialReady(argv: string[]): Promise<boolean> { const key = argv.join("\0"), cached = credentialCache.get(key); if (cached && Date.now() - cached.at < 30_000) return cached.ready; const ready = await execFileAsync(argv[0]!, [...argv.slice(1), "login", "status"], { env: safeRuntimeEnv(), timeout: 10_000 }).then(() => true, () => false); credentialCache.set(key, { at: Date.now(), ready }); return ready; }
function splitCommand(value: string): string[] { return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")) ?? []; }
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout; }
async function localRefExists(repository: string, branch: string): Promise<boolean> {
  return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository })
    .then(() => true, (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
      throw error;
    });
}
function localBranchName(taskId: string, generation: string, attempt: number): string {
  const task = refSlug(taskId, "task");
  const execution = refSlug(generation, "standalone");
  const retry = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return `runforge/${task}/${execution}-attempt-${retry}`;
}
function refSlug(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback; }
function addedPatchLines(patch: string): string {
  const added: string[] = [];
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) { inHunk = false; continue; }
    if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}
function lines(text: string): string[] { return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function isInside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")); }
async function progress(request: ImplementationExecutorRequest, phase: string, detail: string): Promise<void> { await request.onProgress?.(phase, detail); }
function validateChangedPaths(files: string[], zones: string[], max: number): string[] { const errors: string[] = []; if (files.length > max) errors.push(`Changed files exceed limit ${max}.`); const pathZones = zones.filter((zone) => !/\s/.test(zone)).map((zone) => zone.replace(/^\.\//, "").replace(/\*\*|\*/g, "").replace(/\/$/, "")); for (const file of files) { if (file.startsWith("../") || file.startsWith("/")) errors.push(`Path escapes workspace: ${file}.`); const zone = pathZones.find((item) => item && (file === item || file.startsWith(`${item}/`))); if (zone) errors.push(`Changed path is forbidden: ${file} (${zone}).`); } return errors; }
function unsafeDirtyLines(status: string): string[] { return lines(status).filter((line) => { const path = line.slice(3).replace(/^"|"$/g, ""); return !path.startsWith(".runforge/") && !path.startsWith(".runforge-") && !path.startsWith("artifacts/"); }); }
function buildPrompt(request: ImplementationExecutorRequest, iteration: number, validations: CommandDiagnostic[]): string { const context = request.spec.discovery.explicitFiles; return [`You are the RunForge bounded implementation executor. Work only in the current disposable Git worktree.`, `Task: ${request.spec.task.text}`, `Goal: ${request.spec.task.goal}`, `Acceptance criteria:\n${request.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, `Bounded context profile: ${request.spec.discovery.profile}; max ${request.spec.discovery.maxFiles} files, ${request.spec.discovery.maxBytes} bytes, approximately ${request.spec.discovery.maxTokens} tokens. Start with only these explicit files:\n${context.length ? context.map((item) => `- ${item}`).join("\n") : "- Files named by the task and validation commands"}\nStop condition: ${request.spec.discovery.stopCondition}\nDo not enumerate or read the full repository/governance corpus. If context must expand, state the exact file and reason first.`, `Forbidden zones:\n${request.forbiddenZones.map((item) => `- ${item}`).join("\n")}`, `Validation commands:\n${request.validationProfile.commands.map((item) => `- ${item}`).join("\n")}`, `Provider token budget: at most ${request.spec.execution.maxProviderTokens} total and ${request.spec.execution.phaseBudgets[iteration === 0 ? "implementation" : "repair"]} for this phase.`, ...(request.checkpointRepair ? [`Verified repair source: checkpoint ${request.checkpointRepair.checkpointId} (${request.checkpointRepair.checkpointDigest}).${request.checkpointRepair.repairIntent ? ` Bounded owner repair intent: ${request.checkpointRepair.repairIntent}` : ""}`] : []), `Iteration: ${iteration}. ${iteration ? `Repair these failures:\n${validations.filter((item) => item.exitCode !== 0).map((item) => `${item.command}\nstdout: ${item.stdout}\nstderr: ${item.stderr}`).join("\n")}` : "Inspect, plan, implement, and add/update tests as required."}`, `Do not create a Git commit; leave changes uncommitted so RunForge can validate and create the final local commit.`, `Do not push, open a PR, merge, deploy, access secrets/DB/production, or modify forbidden paths. Do not merely propose a patch: edit files and validate. If no change is required, say exactly 'no change required' with evidence. If semantics are ambiguous, stop and say 'ambiguous product decision'.`].join("\n\n"); }
async function buildContextPlan(request: ImplementationExecutorRequest, root: string): Promise<Record<string, unknown>> {
  const mentioned = request.spec.task.text.match(/(?:src|tests|scripts|schemas|docs|config)\/[A-Za-z0-9._/-]+/g) ?? [];
  const files = [...new Set([...request.spec.discovery.explicitFiles, ...mentioned])].slice(0, request.spec.discovery.maxFiles);
  const reads = await Promise.all(files.map(async (file) => { const path = resolve(root, file); if (!isInside(root, path)) return { file, status: "rejected", reason: "path escapes workspace" }; const bytes = await readFile(path).then((value) => value.byteLength, () => 0); return { file, status: bytes ? "planned" : "missing_or_new", bytes, reason: "explicit task scope" }; }));
  const totalBytes = reads.reduce((sum, item) => sum + ("bytes" in item && typeof item.bytes === "number" ? item.bytes : 0), 0);
  return { schemaVersion: 1, profile: request.spec.discovery.profile, limits: { maxFiles: request.spec.discovery.maxFiles, maxBytes: request.spec.discovery.maxBytes, maxTokens: request.spec.discovery.maxTokens }, reads, deduplicated: true, totalFiles: reads.length, totalBytes, withinBounds: reads.length <= request.spec.discovery.maxFiles && totalBytes <= request.spec.discovery.maxBytes, stopCondition: request.spec.discovery.stopCondition, expansionPolicy: "Every additional file requires an explicit reason in provider evidence." };
}
async function runAgent(commandText: string, model: string | null, cwd: string, prompt: string, timeoutMs: number, signal: AbortSignal | undefined, root: string, iteration: number | "semantic-review"): Promise<{ startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null; summary: string; cancelled: boolean; timedOut: boolean; stdout: string; stderr: string; truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; failureReason: string | null; tokenUsage: number | null; stdoutArtifact: string; stderrArtifact: string }> {
  const argv = splitCommand(commandText); const command = argv.shift()!; const isCodex = /(?:^|\/)codex$/.test(command);
  const args = isCodex ? [...argv, "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", cwd, ...(model ? ["--model", model] : []), prompt] : argv;
  const started = Date.now(), startedAt = new Date(started).toISOString(); let stdout = "", stderr = "", timedOut = false, cancelled = false;
  const stdoutArtifact = `provider/iteration-${iteration}.stdout.log`, stderrArtifact = `provider/iteration-${iteration}.stderr.log`;
  await mkdir(join(root, "provider"), { recursive: true });
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: [isCodex ? "ignore" : "pipe", "pipe", "pipe"], env: { ...safeRuntimeEnv(), RUNFORGE_IMPLEMENTATION_REQUEST: join(root, "task-spec.normalized.json"), RUNFORGE_IMPLEMENTATION_PROMPT: prompt, RUNFORGE_NETWORK_POLICY: "provider-only" } });
    if (!isCodex) { child.stdin?.end(prompt); }
    const stop = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { if (Buffer.byteLength(stdout) < 2_000_000) stdout += chunk; }); child.stderr?.on("data", (chunk) => { if (Buffer.byteLength(stderr) < 2_000_000) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); const finishedAt = new Date().toISOString(); const safeStdout = redactProviderOutput(stdout), safeStderr = redactProviderOutput(stderr); const normalizedExit = timedOut ? null : exitCode; const failureReason = normalizedExit === 0 ? null : timedOut ? `Implementation provider timed out after ${timeoutMs}ms.` : cancelled ? "Implementation provider was cancelled." : safeStdout.trim() || safeStderr.trim() ? `Implementation provider exited with code ${normalizedExit ?? "signal"}.` : "Implementation provider exited non-zero without stdout or stderr."; void Promise.all([writeFile(join(root, stdoutArtifact), safeStdout), writeFile(join(root, stderrArtifact), safeStderr)]).then(() => resolveRun({ startedAt, finishedAt, durationMs: Date.now() - started, exitCode: normalizedExit, signal: childSignal, summary: extractSummary(safeStdout, safeStderr), cancelled, timedOut, stdout: safeStdout, stderr: safeStderr, truncation: { stdout: Buffer.byteLength(stdout) >= 2_000_000, stderr: Buffer.byteLength(stderr) >= 2_000_000, limitBytes: 2_000_000 }, failureReason, tokenUsage: extractTokenUsage(safeStdout), stdoutArtifact, stderrArtifact }), reject); });
  });
}
function extractSummary(stdout: string, stderr: string): string { const finals = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const text = item.msg?.message ?? item.message ?? item.text ?? item.item?.text; return typeof text === "string" ? [text] : []; } catch { return []; } }); return (finals.at(-1) ?? stdout ?? stderr).slice(-20_000); }
export function extractTokenUsage(stdout: string): number | null { const values = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const usage = item.usage ?? item.token_usage ?? item.item?.usage; const input = usage?.input_tokens ?? usage?.inputTokens, cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0, output = usage?.output_tokens ?? usage?.outputTokens; if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached)) return [Math.max(0, Number(input) - Number(cached)) + Number(output)]; const explicit = usage?.total_tokens ?? usage?.totalTokens ?? item.total_tokens; return Number.isFinite(explicit) ? [Number(explicit)] : []; } catch { return []; } }); return values.length ? Math.max(...values) : null; }
function safeRuntimeEnv(): NodeJS.ProcessEnv { const allowed = ["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]; return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
function redactProviderOutput(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
