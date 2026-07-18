import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runForgeRoot } from "../core/version.js";
import { runTaskRunHarness, type TaskRunResult } from "../run/task-run-harness.js";
import { runExternalExecution, type ExternalExecutionResult } from "../run/external-execution.js";
import { loadTaskSpecV2, redactedTaskSpec, type TaskSpecV2 } from "./task-spec-v2.js";
import {
  buildAgreementAwareTaskResult,
  completionStatusForAgreement,
  completionStatusForIntent,
  externalResultContract,
  readExternalValidationResults,
  validateTaskResultContract,
  type NormalizedHandoffInput,
  type ResultNextAction,
  type RunForgeCompletionStatus,
} from "./task-result-contract.js";
import { inspectProject, type ProjectInspection } from "./project-inspection.js";
import { runImplementationExecutor, type ImplementationExecutorResult } from "../implementation/executor.js";
import {
  completeExecutionPhase,
  executionPhaseOwner,
  negotiateExecutionAgreement,
  type ExecutionAgreement,
  type ExecutionPhaseId,
} from "./execution-agreement.js";

export type TaskSpecExecution =
  | { kind: "validation"; spec: TaskSpecV2; result: TaskRunResult; summary: string; success: boolean }
  | { kind: "repair"; spec: TaskSpecV2; result: ExternalExecutionResult; summary: string; success: boolean }
  | { kind: "implementation"; spec: TaskSpecV2; result: ImplementationExecutorResult; summary: string; success: boolean };
export async function runTaskSpecFile(path: string, context: { signal?: AbortSignal; attempt?: number; executionId?: string; onProgress?: (phase: string, detail: string) => void | Promise<void> } = {}): Promise<TaskSpecExecution> {
  const spec = await loadTaskSpecV2(path);
  const initialTarget = await inspectProject(spec.target.repository, spec.target.workingDirectory);
  await writeNormalizedSpec(spec);
  if (["implementation", "repair"].includes(spec.execution.mode) && spec.repair.mode === "none") {
    const result = await preserveSpecOnFailure(spec, initialTarget, () => runImplementationExecutor({
      spec, targetRepository: spec.target.repository, workingDirectory: spec.target.workingDirectory,
      projectProfile: { runtime: spec.runtime.preference }, acceptanceCriteria: spec.task.acceptanceCriteria,
      authorityEnvelope: spec.authority, forbiddenZones: spec.authority.forbiddenAreas,
      runtimePolicy: spec.runtime, validationProfile: spec.validation, artifactRoot: spec.artifacts.root,
      attempt: context.attempt ?? 1, generation: context.executionId ?? "standalone", signal: context.signal, onProgress: context.onProgress
    }));
    clearRepairedFindings(result);
    const status = await finalizeImplementationArtifacts(spec, result, context.executionId !== undefined);
    return { kind: "implementation", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: ["implemented_and_validated", "no_change_required"].includes(result.status) };
  }
  if (spec.repair.mode === "none") {
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

async function finalizeImplementationArtifacts(spec: TaskSpecV2, result: ImplementationExecutorResult, legacySettlement: boolean): Promise<RunForgeCompletionStatus> {
  const completed = ["implemented_and_validated", "no_change_required"].includes(result.status);
  const ownerRequired = result.status === "blocked_with_owner_gate";
  const agreement = implementationAgreement(spec, result, completed);
  const status: RunForgeCompletionStatus = completed
    ? completionStatusForAgreement(agreement)
    : ownerRequired ? "awaiting_owner" : "failed";
  const next = implementationNextAction(status, agreement); const handoff = implementationHandoff(spec, result, status, next);
  const agreementAware = buildAgreementAwareTaskResult({ taskId: spec.taskId, status, agreement, handoff, next });
  const settlement = legacySettlement
    ? { schemaVersion: 1 as const, contract: "runforge-task-result" as const, taskId: spec.taskId, status: completed ? "completed" : ownerRequired ? "awaiting_owner_decision" : "failed", workflow: agreementAware }
    : agreementAware;
  const document = {
    ...settlement,
    requestedIntent: spec.execution.mode, actualExecutorMode: "implementation", selectedExecutor: result.selectedExecutor,
    implementation: { status: result.status, performed: result.changedFiles.length > 0, plan: result.plan, changedFiles: result.changedFiles, localBranch: result.localBranch, localCommit: result.localCommit, patchPackage: result.patchPackage, unresolvedAcceptanceCriteria: result.unresolvedFindings },
    targetRepository: { path: spec.target.repository, repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory), initialSha: spec.target.expectedSha, finalSha: spec.target.expectedSha, changed: false },
    completedWork: result.changedFiles.map((file) => ({ file, status: "changed_in_disposable_workspace" })),
    validation: result.validationResults,
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", plan: "implementation-plan.json", patch: result.patchPackage ? "implementation.patch" : null },
    git: { branch: result.localBranch, commit: result.localCommit, patchPackage: result.patchPackage, pullRequest: null, merge: null },
    publication: { status: "on_hold", ownerGate: { required: false, status: "not_requested" }, performed: false },
    providerCalls: result.providerCalls,
    ownerGate: { required: ownerRequired, status: ownerRequired ? "awaiting_owner_decision" : "not_required", ...(result.ownerGate.reason ? { reason: result.ownerGate.reason } : {}) },
    nextAction: { recommendation: completed ? "Review the local commit/patch package, then use the separate publication decision API if publication is desired and authorized." : ownerRequired ? "Resolve the bounded owner gate, then retry with a new generation." : "Inspect structured executor and validation diagnostics, correct the infrastructure/backend failure, and retry." },
    safetyAssertions: { targetUnchanged: true, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: result.providerCalls.length > 0, ...result.safetyAssertions },
    diagnostics: result.diagnostics, errors: result.status === "failed_with_diagnostics" ? result.unresolvedFindings : [], limitations: ownerRequired ? result.unresolvedFindings : []
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} implementation result\n\nOutcome: **${result.status}**\n\nWorkflow status: **${status}**\n\nExecutor: **${result.selectedExecutor.id}**${result.selectedExecutor.model ? ` / ${result.selectedExecutor.model}` : ""}\n\nChanged files: ${result.changedFiles.length ? result.changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}\n\nValidation: ${result.validationResults.every((item) => item.exitCode === 0) ? "passed" : "not green"}\n\nLocal branch: ${result.localBranch ?? "none"}\nLocal commit: ${result.localCommit ?? "none"}\nPatch package: ${result.patchPackage ?? "none"}\n\nPublication: **on hold; not performed**.\n`, "utf8");
  return status;
}

const IMPLEMENTATION_PHASES = new Set<ExecutionPhaseId>([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

function implementationAgreement(spec: TaskSpecV2, result: ImplementationExecutorResult, completed: boolean): ExecutionAgreement {
  const enabled = Object.fromEntries([...IMPLEMENTATION_PHASES].map((phase) => [phase, true]));
  let agreement = negotiateExecutionAgreement({
    profile: spec.executionAgreement.profile,
    requested: spec.authority.allowProviderCalls ? undefined : { providerModelCalls: false },
    requestedOwnership: spec.executionAgreement.phaseOwnership,
    technicalCapability: enabled,
    authority: { ...enabled, providerModelCalls: spec.authority.allowProviderCalls },
    policy: enabled,
  });
  if (!completed) return agreement;
  for (const phase of agreement.phases) {
    if (!phase.requested || phase.responsibleParty !== "runforge" || phase.status === "conflict") continue;
    const evidence = implementationPhaseEvidence(phase.phaseId, result);
    if (evidence.length) agreement = completeExecutionPhase(agreement, phase.phaseId, evidence);
  }
  return agreement;
}

function implementationPhaseEvidence(phase: ExecutionPhaseId, result: ImplementationExecutorResult): string[] {
  if (phase === "implementation") return result.changedFiles.length ? result.changedFiles : ["no_change_required"];
  if (phase === "localValidation") return result.validationResults.length
    ? result.validationResults.flatMap((item) => item.artifactPaths)
    : ["no_change_required"];
  if (phase === "patchPackage") return [result.patchPackage ?? "no_change_required"];
  if (phase === "localBranch") return result.localBranch ? [result.localBranch] : [];
  if (phase === "localCommit") return result.localCommit ? [result.localCommit] : [];
  if (phase === "providerModelCalls") return result.providerCalls.flatMap((call) =>
    Array.isArray(call.artifactPaths) ? call.artifactPaths.filter((item): item is string => typeof item === "string") : []
  ).concat(result.providerCalls.length ? [] : ["no_provider_call_required"]);
  return ["implementation-plan.json"];
}

function implementationNextAction(status: RunForgeCompletionStatus, agreement: ExecutionAgreement): ResultNextAction {
  if (status === "awaiting_owner") return {
    party: "owner", exactAction: "Resolve the bounded owner gate, then start a new execution generation.", gates: [], evidence: [],
  };
  if (status === "failed" || status === "blocked_by_capability" || status === "blocked_by_policy") return {
    party: "runforge", exactAction: "Inspect the structured diagnostics, correct the in-scope failure, and retry.", gates: [], evidence: [],
  };
  const awaiting = agreement.phases.find((phase) => phase.requested && phase.status !== "completed" && phase.responsibleParty !== "runforge" && phase.responsibleParty !== "nobody");
  if (awaiting) return {
    party: awaiting.responsibleParty as ResultNextAction["party"],
    exactAction: `Complete the delegated ${awaiting.phaseId} phase and attach its completion evidence.`,
    gates: awaiting.prerequisites.map((prerequisite) => ({ name: prerequisite, status: "pending", evidence: [] })),
    evidence: [],
  };
  if (status === "workflow_completed") return {
    party: "owner", exactAction: "Preserve the result artifacts; no further RunForge execution is required.", gates: [], evidence: [],
  };
  return {
    party: "runforge", exactAction: "Inspect the structured diagnostics, correct the in-scope failure, and retry.", gates: [], evidence: [],
  };
}

function implementationHandoff(
  spec: TaskSpecV2,
  result: ImplementationExecutorResult,
  status: RunForgeCompletionStatus,
  next: ResultNextAction,
): NormalizedHandoffInput {
  return {
    profile: executionPhaseOwner(spec.executionAgreement.profile, "localCommit", spec.executionAgreement.phaseOwnership) === "runforge" ? "local-ready" : "assist-only",
    summary: `RunForge implementation finished with '${result.status}' and workflow status '${status}'.`,
    changedFiles: result.changedFiles,
    patch: result.patchPackage ? "implementation.patch" : null,
    commit: result.localCommit,
    validation: result.validationResults.map((item) => ({
      command: item.command,
      status: item.exitCode === 0 ? "passed" as const : "failed" as const,
      exitCode: item.exitCode,
      evidence: item.artifactPaths,
    })),
    findings: result.unresolvedFindings,
    risks: status === "workflow_completed" ? [] : ["The remaining workflow phase is outside this completed RunForge execution."],
    nextActions: [next],
    publicationInstructions: ["Publication remains on hold and requires a separate authorized action."],
    ciCommands: spec.validation.commands,
    safety: {
      providerCalls: result.providerCalls.length > 0,
      notes: ["The target checkout was preserved; no push, merge, deploy, database, production, or secret access was performed."],
    },
    targetSha: result.localCommit ?? spec.target.expectedSha,
    baseSha: spec.target.expectedSha,
  };
}

function clearRepairedFindings(result: ImplementationExecutorResult): void {
  if (result.status === "implemented_and_validated" && result.validationResults.length > 0 && result.validationResults.every((item) => item.exitCode === 0)) {
    result.unresolvedFindings = [];
  }
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
