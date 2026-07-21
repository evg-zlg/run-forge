import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { detectPackageValidationCapabilities } from "../implementation/validation-runtime-capabilities.js";
import { runValidation, type CommandDiagnostic } from "../implementation/validation-command-runner.js";
import type { SemanticReviewResult } from "../implementation/semantic-review.js";
import type { ExecutionAgreement, ExecutionPhaseAgreement } from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
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
  onProgress?: (phase: string, detail: string) => void | Promise<void>;
}): Promise<ValidationOnlyExecutorResult> {
  const { spec } = input;
  if (spec.runtime.preference === "local-disposable") {
    throw new Error("Validation-only execution requires Docker; a disposable local workspace is disabled by external-target policy.");
  }
  const sourceBefore = await inspectRepoState(spec.target.repository);
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
    await prepareUnpreparedExternalWorkspace(spec.target.repository, workspace, spec.target.workingDirectory);
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
    ? new DockerShellExecutor(process.cwd(), spec.runtime.dockerImage, true, preparation === null && sourceDependencies ? join(spec.target.repository, spec.target.workingDirectory, "node_modules") : undefined)
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
  const sourceAfter = await inspectRepoState(spec.target.repository);
  const unchanged = sourceBefore.head === sourceAfter.head && sourceBefore.status === sourceAfter.status;
  if (!unchanged) throw new Error("source_mutation_detected_during_validation");
  const semanticPhase = input.executionAgreement.phases.find((phase) => phase.phaseId === "independentReview");
  if (!semanticPhase) throw new Error("Execution Agreement is missing the independentReview phase.");
  const delegation = semanticReviewDelegation(semanticPhase);
  const semantic: SemanticReviewResult = {
    kind: "semantic", status: "unavailable", performed: false,
    selectedReviewer: { provider: null, model: null }, reviewer: { provider: null, model: null, invocationId: null },
    confidence: "unknown", limitations: ["Validation-only execution provides structural evidence but does not invoke an independent semantic reviewer."],
    findings: [], evidence: [], delegation,
  };
  const review = { structural: { kind: "structural" as const, status: validationAggregate, evidence: validationResults.flatMap((item) => item.artifactPaths) }, semantic };
  const completed = ["passed", "completed_with_validation_gaps"].includes(validationAggregate);
  return { status: completed ? "completed" : "failed", validationPlan, validationAggregate, validationResults, source: { before: sourceBefore, after: sourceAfter, unchanged }, productWorkspace: workspace, preparation, review, executionAgreement: input.executionAgreement };
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
