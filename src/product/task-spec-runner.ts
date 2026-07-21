import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runForgeRoot } from "../core/version.js";
import { runTaskRunHarness, type TaskRunResult } from "../run/task-run-harness.js";
import { runExternalExecution, type ExternalExecutionResult } from "../run/external-execution.js";
import { loadTaskSpecV2, redactedTaskSpec, type TaskSpecV2 } from "./task-spec-v2.js";
import {
  completionStatusForIntent,
  externalResultContract,
  readExternalValidationResults,
  validateTaskResultContract,
} from "./task-result-contract.js";
import { inspectProject, type ProjectInspection } from "./project-inspection.js";
import { runImplementationExecutor, type ImplementationExecutorResult } from "../implementation/executor.js";
import { runValidationOnlyExecutor, type ValidationOnlyExecutorResult } from "../validation/validation-only-executor.js";
import { withDockerValidationTempVolume } from "../run/docker-validation-temp-volume.js";
import { completeExecutionPhase, EXECUTION_PHASE_IDS, negotiateExecutionAgreement, type ExecutionAgreement } from "./execution-agreement.js";
import { buildAgreementAwareTaskResult, completionStatusForAgreement, type NormalizedHandoffInput, type ResultNextAction } from "./task-result-contract.js";
import {
  clearRepairedFindings,
  delegatedImplementationParty,
  finalizeDelegatedImplementationArtifacts,
  finalizeImplementationArtifacts,
} from "./task-spec-implementation-result.js";

export type TaskSpecExecution =
  | { kind: "validation"; spec: TaskSpecV2; result: TaskRunResult | ValidationOnlyExecutorResult; summary: string; success: boolean }
  | { kind: "repair"; spec: TaskSpecV2; result: ExternalExecutionResult; summary: string; success: boolean }
  | { kind: "implementation"; spec: TaskSpecV2; result: ImplementationExecutorResult | AgreementHandoffResult; summary: string; success: boolean };
type AgreementHandoffResult = { status: "delegated"; responsibleParty: "external_session" | "external_system"; selectedExecutor: { id: "agreement-handoff"; model: null }; providerCalls: []; publicationMutations: 0 };
export async function runTaskSpecFile(path: string, context: { signal?: AbortSignal; attempt?: number; executionId?: string; executionAgreementId?: string; executionAgreement?: ExecutionAgreement; checkpointRepair?: { patchPath: string; checkpointId: string; checkpointDigest: string; repairIntent: string | null }; onProgress?: (phase: string, detail: string) => void | Promise<void> } = {}): Promise<TaskSpecExecution> {
  const spec = await loadTaskSpecV2(path);
  const initialTarget = await inspectProject(spec.target.repository, spec.target.workingDirectory);
  await writeNormalizedSpec(spec);
  const delegatedParty = delegatedImplementationParty(spec);
  if (["implementation", "repair"].includes(spec.execution.mode) && delegatedParty) {
    const result: AgreementHandoffResult = { status: "delegated", responsibleParty: delegatedParty, selectedExecutor: { id: "agreement-handoff", model: null }, providerCalls: [], publicationMutations: 0 };
    const status = await finalizeDelegatedImplementationArtifacts(spec, initialTarget, delegatedParty, context.executionId !== undefined);
    return { kind: "implementation", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: true };
  }
  if (["implementation", "repair"].includes(spec.execution.mode) && spec.repair.mode === "none") {
    const result = await preserveSpecOnFailure(spec, initialTarget, () => runImplementationExecutor({
      spec, targetRepository: spec.target.repository, workingDirectory: spec.target.workingDirectory,
      projectProfile: { runtime: spec.runtime.preference }, acceptanceCriteria: spec.task.acceptanceCriteria,
      authorityEnvelope: spec.authority, forbiddenZones: spec.authority.forbiddenAreas,
      runtimePolicy: spec.runtime, validationProfile: spec.validation, artifactRoot: spec.artifacts.root,
      attempt: context.attempt ?? 1, generation: context.executionId ?? "standalone", executionAgreementId: context.executionAgreementId ?? `task-spec:${spec.executionAgreement.profile}`, signal: context.signal, checkpointRepair: context.checkpointRepair, onProgress: context.onProgress
    }));
    clearRepairedFindings(result);
    const status = await finalizeImplementationArtifacts(spec, result, context.executionId !== undefined);
    return { kind: "implementation", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: ["implemented_and_validated", "no_change_required"].includes(result.status) };
  }
  if (spec.repair.mode === "none") {
    if (spec.execution.mode === "validation") {
      const agreement = context.executionAgreement ?? validationExecutionAgreement(spec);
      const execute = async (tempVolume?: string): Promise<TaskSpecExecution> => {
        const result = await preserveSpecOnFailure(spec, initialTarget, () => runValidationOnlyExecutor({
          spec, executionAgreement: agreement, ...(tempVolume ? { tempVolume } : {}), ...(context.signal ? { signal: context.signal } : {}), ...(context.onProgress ? { onProgress: context.onProgress } : {}),
        }));
        await writeNormalizedSpec(spec);
        await finalizeCapabilityAwareValidationArtifacts(spec, result, context.executionId !== undefined);
        return { kind: "validation", spec, result, summary: `TaskSpec ${spec.taskId}: ${result.status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: result.status === "completed" };
      };
      const volumeScope = context.executionId ? `${spec.taskId}-${context.executionId}` : spec.taskId;
      return spec.runtime.preference === "docker" ? withDockerValidationTempVolume(volumeScope, execute) : execute();
    }
    const result = await preserveSpecOnFailure(spec, initialTarget, () => runTaskRunHarness({
      taskId: spec.taskId,
      executionRoot: runForgeRoot(),
      forceExternal: true,
      task: `${spec.task.text}\nGoal: ${spec.task.goal}\nAcceptance: ${spec.task.acceptanceCriteria.join("; ")}`,
      out: spec.artifacts.root,
      repo: spec.target.repository,
      workingDirectory: spec.target.workingDirectory,
      commands: spec.validation.commands,
      runtime: spec.runtime.preference === "local-disposable" ? "local" : "docker",
      allowDisposableLocal: false,
      dockerImage: spec.runtime.dockerImage,
      prepareRuntime: spec.runtime.dependencyPreparation === "required" ? "explicit" : "none",
      tmpRoot: join(dirname(spec.artifacts.root), ".runforge-task-runs", spec.taskId),
      checkCommand: "node --version"
    }));
    await writeNormalizedSpec(spec);
    await finalizeValidationArtifacts(spec, result);
    const status = completionStatusForIntent({ executionStatus: result.status, implementationExpected: spec.authority.profile === "bounded-implementation", targetChanged: false });
    return { kind: "validation", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: status === "completed" };
  }
  const result = await preserveSpecOnFailure(spec, initialTarget, () => runExternalExecution({
    taskId: spec.taskId,
    task: spec.task.text,
    out: spec.artifacts.root,
    repo: spec.target.repository,
    workingDirectory: spec.target.workingDirectory,
    runtime: spec.runtime.preference === "local-disposable" ? "local" : "docker",
    dockerImage: spec.runtime.dockerImage,
    prepareRuntime: spec.runtime.dependencyPreparation === "required" ? "explicit" : "none",
    dependencyPreparation: spec.runtime.dependencyPreparation,
    externalNetwork: spec.runtime.externalNetwork === "allowed" ? "denied" : spec.runtime.externalNetwork,
    repairMode: spec.repair.mode,
    repairPlan: spec.repair.plan ?? undefined,
    existingCandidates: [],
    authority: spec.authority.envelopeFile ?? undefined,
    approvalMode: "require-owner-decision",
    applyMode: spec.git.publication === "draft-pr" ? "local-non-main-branch" : "none",
    targetBranch: spec.git.branch ?? undefined,
    publicationMode: spec.git.publication,
    commands: spec.validation.commands,
    tmpRoot: join(dirname(spec.artifacts.root), ".runforge-task-runs", spec.taskId),
    timeoutMs: 300_000
  }));
  await writeNormalizedSpec(spec);
  const status = await finalizeRepairArtifacts(spec, result);
  return { kind: "repair", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: ["completed", "awaiting_owner_decision"].includes(status) };
}

async function finalizeCapabilityAwareValidationArtifacts(spec: TaskSpecV2, result: ValidationOnlyExecutorResult, legacySettlement: boolean): Promise<void> {
  let agreement = result.executionAgreement;
  for (const [phaseId, evidence] of [
    ["projectDiscovery", ["task-spec.normalized.json"]],
    ["taskAnalysis", ["validation-plan.json"]],
    ["localValidation", result.review.structural.evidence],
  ] as const) {
    const phase = agreement.phases.find((item) => item.phaseId === phaseId);
    if (phase?.requested && phase.responsibleParty === "runforge" && phase.status !== "completed" && phase.status !== "conflict") agreement = completeExecutionPhase(agreement, phaseId, evidence.length ? evidence : ["validation-plan.json"]);
  }
  const workflowStatus = result.validationAggregate === "blocked_by_capability" ? "blocked_by_capability"
    : result.validationAggregate === "blocked_by_policy" ? "blocked_by_policy"
      : result.status === "completed" ? completionStatusForAgreement(agreement) : "failed";
  const delegation = result.review.semantic.delegation!;
  const next: ResultNextAction = {
    party: delegation.party,
    exactAction: delegation.exactAction,
    gates: [], evidence: result.review.structural.evidence.map((reference) => ({ kind: "artifact", reference, summary: "Structural validation evidence." })),
  };
  const handoff: NormalizedHandoffInput = {
    profile: "assist-only",
    summary: `Validation-only execution completed with aggregate ${result.validationAggregate}; no implementation or publication was performed.`,
    changedFiles: [], patch: null, branch: null, commit: null,
    validation: result.validationResults.map((item) => ({ command: item.command, status: item.outcome, exitCode: item.exitCode, evidence: item.artifactPaths, lane: item.lane, cwd: item.cwd, ...(item.argv ? { argv: item.argv } : {}), repositoryIdentity: item.repositoryIdentity, boundSha: item.boundSha, capabilities: item.requiredCapabilities, safetyAssertions: item.safetyAssertions })),
    findings: [], structuralEvidence: result.review.structural.evidence.map((reference) => ({ kind: "artifact", reference, summary: "Structural validation evidence." })), semanticReview: result.review.semantic,
    risks: result.validationResults.filter((item) => item.outcome !== "passed").map((item) => `${item.command}: ${item.outcome}${item.failureReason ? ` (${item.failureReason})` : ""}`),
    nextActions: [next], publicationInstructions: ["Publication was not requested or performed."], ciCommands: spec.validation.commands,
    safety: { providerCalls: false, notes: ["Source SHA and worktree state were unchanged; unsupported and policy-skipped commands were not spawned."] },
    targetSha: result.source.after.head, baseSha: result.source.before.head,
  };
  const workflow = buildAgreementAwareTaskResult({ taskId: spec.taskId, status: workflowStatus, agreement, handoff, next, validationPlan: result.validationPlan, validationAggregate: result.validationAggregate, review: result.review });
  const status = result.status === "completed" ? "completed" : result.validationAggregate === "blocked_by_capability" ? "blocked_by_capability" : result.validationAggregate === "blocked_by_policy" ? "blocked_by_policy" : "failed";
  const settlement: Record<string, unknown> = legacySettlement
    ? { schemaVersion: 1, contract: "runforge-task-result", taskId: spec.taskId, status, workflow }
    : workflow;
  const document = {
    ...settlement,
    requestedIntent: spec.execution.mode, actualExecutorMode: "validation", validationPlan: result.validationPlan, validationAggregate: result.validationAggregate,
    validation: result.validationResults, review: result.review,
    targetRepository: { path: spec.target.repository, repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory), initialSha: result.source.before.head, finalSha: result.source.after.head, changed: !result.source.unchanged, initialStatus: result.source.before.status, finalStatus: result.source.after.status },
    completedWork: result.validationResults.filter((item) => item.outcome === "passed").map((item) => ({ command: item.command, status: item.outcome, lane: item.lane })),
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", validationPlan: "validation-plan.json" },
    git: { branch: null, commit: null, pullRequest: null, merge: null }, ownerGate: { required: false, status: "not_required" },
    nextAction: { recommendation: next.exactAction },
    safetyAssertions: { targetUnchanged: result.source.unchanged, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false },
    errors: result.status === "failed" ? result.validationResults.filter((item) => item.acceptance === "required" && item.outcome !== "passed").map((item) => `${item.command}: ${item.outcome}`) : [],
    limitations: result.review.semantic.limitations,
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} validation result\n\nStatus: **${status}**\n\nValidation aggregate: **${result.validationAggregate}**\n\nSource unchanged: **${result.source.unchanged}**\n\nStructural review: **${result.review.structural.status}**\n\nSemantic review: **${result.review.semantic.status}**; delegated to **${delegation.party}**.\n\nProvider calls, publication, database, production, secrets, merge, and deploy: **none**.\n`, "utf8");
}

function validationExecutionAgreement(spec: TaskSpecV2): ExecutionAgreement {
  const enabled = Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, true]));
  const requested = Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, ["projectDiscovery", "taskAnalysis", "localValidation"].includes(phase)]));
  return negotiateExecutionAgreement({ profile: spec.executionAgreement.profile, requested, requestedOwnership: spec.executionAgreement.phaseOwnership, technicalCapability: enabled, authority: enabled, policy: enabled });
}

async function preserveSpecOnFailure<T>(spec: TaskSpecV2, initialTarget: ProjectInspection, execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch (error) {
    await writeNormalizedSpec(spec);
    await writeFailureArtifacts(spec, initialTarget, error);
    throw error;
  }
}

async function writeFailureArtifacts(spec: TaskSpecV2, initialTarget: ProjectInspection, error: unknown): Promise<void> {
  const finalTarget = await inspectProject(spec.target.repository, spec.target.workingDirectory);
  const changed = initialTarget.head !== finalTarget.head || initialTarget.worktree.summary !== finalTarget.worktree.summary;
  const reason = error instanceof Error ? error.message : String(error);
  const continuation = `runforge task-run start --spec '${join(spec.artifacts.root, "task-spec.normalized.json").replaceAll("'", `'"'"'`)}'`;
  const document = {
    schemaVersion: 1, contract: "runforge-task-result", taskId: spec.taskId, status: "blocked",
    targetRepository: { path: spec.target.repository, repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory), initialSha: initialTarget.head, finalSha: finalTarget.head, changed },
    completedWork: [], validation: [],
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json" },
    git: { branch: null, commit: null, pullRequest: null, merge: null },
    ownerGate: { required: true, status: "awaiting_owner_decision", reason, options: ["Adjust runtime policy", "Adjust dependency preparation strategy", "Provide or expand authority", "Correct the bounded execution strategy"], continuationCommand: continuation },
    nextAction: { recommendation: `Owner decision required: ${reason} After resolving the gate, continue with: ${continuation}` },
    safetyAssertions: { targetUnchanged: !changed, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false },
    errors: [reason],
    limitations: ["Validation evidence was unavailable at failure finalization."]
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result\n\nStatus: **blocked**\n\n## Owner gate\n\n${reason}\n\nAllowed owner choices: adjust runtime, dependency preparation, authority, or the bounded execution strategy.\n\nContinuation command:\n\n\`${continuation}\`\n\nTarget main push, PR merge, deploy, DB, production, secrets, and provider calls were not performed.\n`, "utf8");
}

async function writeNormalizedSpec(spec: TaskSpecV2): Promise<void> {
  await mkdir(spec.artifacts.root, { recursive: true });
  await writeFile(join(spec.artifacts.root, "task-spec.normalized.json"), JSON.stringify(redactedTaskSpec(spec), null, 2) + "\n", "utf8");
}

async function finalizeValidationArtifacts(spec: TaskSpecV2, result: TaskRunResult): Promise<void> {
  const resultsPath = join(spec.artifacts.root, "results.json");
  const current = JSON.parse(await readFile(resultsPath, "utf8")) as Record<string, unknown>;
  const implementationExpected = spec.authority.profile === "bounded-implementation";
  const completed = result.status === "completed" && !implementationExpected;
  const normalizedStatus = completionStatusForIntent({ executionStatus: result.status, implementationExpected, targetChanged: false });
  const normalized = {
    ...current,
    status: normalizedStatus,
    targetRepository: { ...asRecord(current.targetRepository), repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory) },
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", details: { plan: "plan.md", review: "review/review.md", subtasks: "subtasks/" } },
    ownerGate: implementationExpected ? { required: true, status: "awaiting_owner_decision", reason: "Implementation intent was inspected without producing a patch, commit, or PR.", continuationCommand: `runforge task-run start --spec '${join(spec.artifacts.root, "task-spec.normalized.json")}'` } : { required: false, status: "not_required" },
    nextAction: { recommendation: completed ? "Task completed. Read summary.md and preserve results.json as evidence." : implementationExpected ? "Choose a bounded repair strategy and continue the normalized TaskSpec; inspection alone cannot complete implementation intent." : "Inspect failed validation and safety evidence, resolve the cause, then start a new run." },
    limitations: completed ? [] : [...array(current.limitations), "The read-only task did not satisfy all validation and safety checks."],
    review: { ...asRecord(current.review), humanDecisionRequired: false, recommendedNextAction: completed ? "No owner decision is required for this completed read-only task." : "Inspect failures and rerun after correction; owner approval does not convert failed evidence into success." },
    recommendedNextStep: completed ? "Task completed; preserve the official result artifacts." : "Resolve failed evidence and start a new TaskSpec run.",
    recommendedNextMilestone: null
  };
  validateTaskResultContract(normalized);
  await writeFile(resultsPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  const validations = [
    ...result.subtasks.map((item) => `- \`${item.evidence.command}\`: **${item.evidence.status}** (exit ${item.evidence.exitCode}; task validation)`),
    ...result.checks.map((item) => `- \`${item.command}\`: **${item.result}** (exit ${item.exitCode}; safety check)`)
  ].join("\n");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result

Status: **${normalizedStatus}**

## Task

${spec.task.text}

Goal: ${spec.task.goal}

## Validation

${validations}

## Target safety

- Repository: \`${spec.target.repository}\`
- Initial SHA: \`${result.sourceRepository.before?.head}\`
- Final SHA: \`${result.sourceRepository.after?.head}\`
- Target changed: **${result.sourceRepository.unchanged === false}**
- Main push, PR merge, deploy, DB, production, secrets, and provider calls: **none**

## Owner gate

${implementationExpected ? "Required: implementation intent produced no patch, commit, or PR; inspection is not completion." : `Not required for this read-only task. ${completed ? "The task completed." : "The task failed and must be corrected and rerun; approval cannot override failed evidence."}`}

## Next action

${completed ? "Read `results.json` for the normalized machine-readable record. No continuation is required." : "Read `results.json` and the referenced logs, correct the failure, and start a new run."}
`, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

async function finalizeRepairArtifacts(spec: TaskSpecV2, result: ExternalExecutionResult): Promise<string> {
  const document: Record<string, unknown> = { ...externalResultContract({ taskId: spec.taskId, targetBranch: spec.git.branch ?? undefined }, result, spec.validation.commands), validation: await readExternalValidationResults(spec.artifacts.root, spec.validation.commands), ...result };
  document.targetRepository = { ...asRecord(document.targetRepository), repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory) };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  const status = String(document.status);
  const ownerGate = asRecord(document.ownerGate);
  const nextAction = asRecord(document.nextAction);
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result

Status: **${status}**

- Target: \`${spec.target.repository}\`
- Initial SHA: \`${result.source.before.head}\`
- Final SHA: \`${result.source.after.head}\`
- Target changed: **${!result.source.unchanged}**
- Owner gate: **${String(ownerGate.status)}**
- Main push / target PR merge / deploy / DB / production / secrets: **none**

## Next action

${String(nextAction.recommendation)}
`, "utf8");
  return status;
}
