import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImplementationExecutorResult } from "../implementation/executor.js";
import {
  completeExecutionPhase,
  executionPhaseOwner,
  negotiateExecutionAgreement,
  type ExecutionAgreement,
  type ExecutionPhaseId,
} from "./execution-agreement.js";
import { inspectProject, type ProjectInspection } from "./project-inspection.js";
import {
  buildAgreementAwareTaskResult,
  completionStatusForAgreement,
  validateTaskResultContract,
  type NormalizedHandoffInput,
  type ResultNextAction,
  type RunForgeCompletionStatus,
} from "./task-result-contract.js";
import type { TaskSpecV2 } from "./task-spec-v2.js";

const IMPLEMENTATION_PHASES = new Set<ExecutionPhaseId>([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

export function delegatedImplementationParty(spec: TaskSpecV2): "external_session" | "external_system" | null {
  const party = executionPhaseOwner(spec.executionAgreement.profile, "implementation", spec.executionAgreement.phaseOwnership);
  return party === "external_session" || party === "external_system" ? party : null;
}

export async function finalizeDelegatedImplementationArtifacts(spec: TaskSpecV2, initialTarget: ProjectInspection, party: "external_session" | "external_system", legacySettlement: boolean): Promise<RunForgeCompletionStatus> {
  const enabled = Object.fromEntries([...IMPLEMENTATION_PHASES].map((phase) => [phase, true]));
  let agreement = negotiateExecutionAgreement({
    profile: spec.executionAgreement.profile,
    requested: spec.authority.allowProviderCalls ? undefined : { providerModelCalls: false },
    requestedOwnership: spec.executionAgreement.phaseOwnership,
    technicalCapability: enabled,
    authority: enabled,
    policy: enabled,
  });
  for (const [phaseId, evidence] of [["projectDiscovery", ["task-spec.normalized.json"]], ["taskAnalysis", ["task-spec.normalized.json"]]] as const) {
    const phase = agreement.phases.find((item) => item.phaseId === phaseId);
    if (phase?.requested && phase.responsibleParty === "runforge" && phase.status !== "conflict") agreement = completeExecutionPhase(agreement, phaseId, evidence);
  }
  const implementation = agreement.phases.find((phase) => phase.phaseId === "implementation")!;
  const status: RunForgeCompletionStatus = party === "external_session" ? "awaiting_external_session" : "runforge_scope_completed";
  const next: ResultNextAction = {
    party,
    exactAction: `Complete the delegated implementation phase in ${party} and attach its completion evidence.`,
    gates: implementation.prerequisites.map((name) => ({ name, status: "pending", evidence: [] })),
    evidence: [],
  };
  const finalTarget = await inspectProject(spec.target.repository, spec.target.workingDirectory);
  const sourceUnchanged = initialTarget.head === finalTarget.head && initialTarget.branch === finalTarget.branch && initialTarget.worktree.summary === finalTarget.worktree.summary;
  const handoff: NormalizedHandoffInput = {
    profile: "assist-only",
    summary: `RunForge performed safe agreement and project discovery only; implementation is delegated to ${party}.`,
    changedFiles: [], patch: null, branch: null, commit: null, validation: [], findings: [],
    risks: ["Implementation and validation remain outside this RunForge execution."],
    nextActions: [next],
    publicationInstructions: ["Publication was not requested or performed by this agreement-handoff lane."],
    ciCommands: spec.validation.commands,
    safety: { providerCalls: false, notes: ["No coding agent, provider call, source mutation, publication, push, merge, deploy, database, production, or secret action was performed."] },
    targetSha: finalTarget.head,
    baseSha: initialTarget.head,
  };
  const agreementAware = buildAgreementAwareTaskResult({ taskId: spec.taskId, status, agreement, handoff, next });
  const settlement = legacySettlement
    ? { schemaVersion: 1 as const, contract: "runforge-task-result" as const, taskId: spec.taskId, status: "completed", workflow: agreementAware }
    : agreementAware;
  const document = {
    ...settlement,
    requestedIntent: spec.execution.mode,
    actualExecutorMode: "agreement-handoff",
    selectedExecutor: { id: "agreement-handoff", model: null },
    implementation: { status: "delegated", performed: false, responsibleParty: party, changedFiles: [], localBranch: null, localCommit: null, patchPackage: null, unresolvedAcceptanceCriteria: spec.task.acceptanceCriteria },
    targetRepository: { path: spec.target.repository, repositoryRoot: finalTarget.repositoryRoot, executionRoot: finalTarget.executionRoot, initialSha: initialTarget.head, finalSha: finalTarget.head, changed: !sourceUnchanged, initialBranch: initialTarget.branch, finalBranch: finalTarget.branch, initialStatus: initialTarget.worktree.summary, finalStatus: finalTarget.worktree.summary, refsChanged: false },
    completedWork: [], validation: [],
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", plan: null, patch: null },
    git: { branch: null, commit: null, patchPackage: null, pullRequest: null, merge: null, sourceRefsChanged: false },
    publication: { status: "not_requested", performed: false, mutations: 0 },
    providerCalls: [], providerMutations: 0, publicationMutations: 0,
    ownerGate: { required: false, status: "not_required" },
    nextAction: { recommendation: next.exactAction },
    safetyAssertions: { targetUnchanged: sourceUnchanged, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false },
    diagnostics: {}, errors: [], limitations: ["Implementation and validation were delegated by the effective Execution Agreement."]
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} agreement handoff\n\nRunForge execution status: **${status}**\n\nImplementation owner: **${party}**\n\nNext action: ${next.exactAction}\n\nSource SHA, branch, worktree status, and refs were preserved. Provider and publication mutations: **0**.\n`, "utf8");
  return status;
}

export async function finalizeImplementationArtifacts(spec: TaskSpecV2, result: ImplementationExecutorResult, legacySettlement: boolean): Promise<RunForgeCompletionStatus> {
  const completed = ["implemented_and_validated", "no_change_required"].includes(result.status);
  const ownerRequired = result.ownerGate.required;
  const agreement = implementationAgreement(spec, result, completed);
  const status: RunForgeCompletionStatus = result.validationAggregate === "blocked_by_capability" ? "blocked_by_capability" : result.validationAggregate === "blocked_by_policy" ? "blocked_by_policy" : ownerRequired ? "awaiting_owner" : completed ? completionStatusForAgreement(agreement) : "failed";
  const validationCompleted = ["passed", "completed_with_validation_gaps"].includes(result.validationAggregate);
  const next = implementationNextAction(status, agreement); const handoff = implementationHandoff(spec, result, status, next);
  const agreementAware = buildAgreementAwareTaskResult({ taskId: spec.taskId, status, agreement, handoff, next, validationPlan: result.validationPlan, validationAggregate: result.validationAggregate });
  const legacyStatus = status === "blocked_by_capability" || status === "blocked_by_policy" ? status : completed ? "completed" : ownerRequired ? "awaiting_owner_decision" : "failed";
  const settlement = legacySettlement
    ? { schemaVersion: 1 as const, contract: "runforge-task-result" as const, taskId: spec.taskId, status: legacyStatus, workflow: agreementAware }
    : agreementAware;
  const document = {
    ...settlement,
    requestedIntent: spec.execution.mode, actualExecutorMode: "implementation", selectedExecutor: result.selectedExecutor,
    implementation: { status: result.status, performed: result.changedFiles.length > 0, plan: result.plan, changedFiles: result.changedFiles, localBranch: result.localBranch, localCommit: result.localCommit, patchPackage: result.patchPackage, unresolvedAcceptanceCriteria: result.unresolvedFindings },
    artifact: { status: result.checkpoints.length ? "available" : "unavailable", latestCheckpointId: result.checkpoints.at(-1)?.id ?? null, bestValidatedCheckpointId: [...result.checkpoints].reverse().find((item) => item.validationPassed)?.id ?? null, checkpoints: result.checkpoints },
    workflow: { ...objectRecord(documentWorkflow(settlement)), status: ownerRequired ? "awaiting_owner" : objectRecord(documentWorkflow(settlement)).status ?? (completed ? "completed" : "failed"), implementationCompleted: completed, validationCompleted, validationAggregate: result.validationAggregate, budgetExceeded: result.budget.exceeded, publicationBlocked: true, ownerDecisionRequired: ownerRequired },
    targetRepository: { path: spec.target.repository, repositoryRoot: spec.target.repository, executionRoot: join(spec.target.repository, spec.target.workingDirectory), initialSha: spec.target.expectedSha, finalSha: spec.target.expectedSha, changed: false },
    completedWork: result.changedFiles.map((file) => ({ file, status: "changed_in_disposable_workspace" })),
    validationPlan: result.validationPlan, validationAggregate: result.validationAggregate, validation: result.validationResults,
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", plan: "implementation-plan.json", contextPlan: "context-plan.json", validationPlan: "validation-plan.json", patch: result.patchPackage ? "implementation.patch" : null, checkpoints: result.checkpoints.map((item) => item.path) },
    git: { branch: result.localBranch, commit: result.localCommit, patchPackage: result.patchPackage, pullRequest: null, merge: null },
    publication: { status: "on_hold", ownerGate: { required: false, status: "not_requested" }, performed: false },
    providerCalls: result.providerCalls,
    usage: phaseUsage(spec, result),
    ownerGate: { required: ownerRequired, status: ownerRequired ? "awaiting_owner_decision" : "not_required", subject: completed ? "Completed implementation checkpoint is available; only continuation/publication is blocked." : "Implementation needs an owner decision.", completed: { implementation: completed, validation: validationCompleted, artifacts: result.checkpoints.map((item) => item.id) }, blocked: result.budget.exceeded ? ["future_provider_calls", "repair_iterations", "publication", "workflow_completion"] : ["workflow_continuation"], options: [
      { id: "accept_completed_patch", endpoint: `/v1/tasks/${spec.taskId}/accept-completed-result`, providerRun: false, grantsAuthority: false }, { id: "grant_additional_budget", endpoint: `/v1/tasks/${spec.taskId}/checkpoint-repairs`, providerRun: true, grantsAuthority: false, requires: ["taskId", "decisionId", "checkpointId", "checkpointDigest", "additionalProviderTokens"] }, { id: "stop_with_handoff", providerRun: false, grantsAuthority: false }, { id: "discard_result", endpoint: `/v1/tasks/${spec.taskId}/discard-result`, providerRun: false, grantsAuthority: false, explicitConfirmationRequired: true }, { id: "retry_from_checkpoint", endpoint: `/v1/tasks/${spec.taskId}/checkpoint-repairs`, providerRun: true, grantsAuthority: false, requires: ["taskId", "decisionId", "checkpointId", "checkpointDigest", "repairIntent"] }
    ], ...(result.ownerGate.reason ? { reason: result.ownerGate.reason } : {}) },
    handoffPackage: { status: result.checkpoints.length ? "available" : "unavailable", latestSafePatch: result.checkpoints.at(-1)?.patchPath ?? result.patchPackage, bestValidatedCheckpoint: [...result.checkpoints].reverse().find((item) => item.validationPassed)?.id ?? null, baseSha: spec.target.expectedSha, applyInstructions: result.checkpoints.length ? `git apply '${result.checkpoints.at(-1)!.patchPath}'` : null, changedFiles: result.changedFiles, validationEvidence: result.validationResults.flatMap((item) => item.artifactPaths), knownLimitations: result.unresolvedFindings, nextResponsibleParty: ownerRequired ? "owner" : "external_session", exactNextAction: ownerRequired ? ([...result.checkpoints].reverse().find((item) => item.validationPassed) ? `POST /v1/tasks/${spec.taskId}/accept-completed-result with the best validated checkpoint ID.` : `POST /v1/tasks/${spec.taskId}/checkpoint-repairs with the task, decision, checkpoint ID and published checkpoint digest; patch-only handoff remains available.`) : "Preserve or publish the patch under separate authority." },
    nextAction: { recommendation: ownerRequired && completed ? "Accept the completed checkpoint without a new provider run, stop with handoff, or explicitly grant additional budget." : completed ? "Review the local commit/patch package, then use the separate publication decision API if publication is desired and authorized." : ownerRequired ? "Resolve the bounded owner gate." : "Inspect structured executor and validation diagnostics, correct the infrastructure/backend failure, and retry." },
    safetyAssertions: { targetUnchanged: true, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: result.providerCalls.length > 0, ...result.safetyAssertions },
    diagnostics: result.diagnostics, errors: result.status === "failed_with_diagnostics" ? result.unresolvedFindings : [], limitations: ownerRequired ? result.unresolvedFindings : []
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} implementation result\n\nOutcome: **${result.status}**\n\nWorkflow status: **${status}**\n\nExecutor: **${result.selectedExecutor.id}**${result.selectedExecutor.model ? ` / ${result.selectedExecutor.model}` : ""}\n\nChanged files: ${result.changedFiles.length ? result.changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}\n\nValidation: **${result.validationAggregate}**\n\nLocal branch: ${result.localBranch ?? "none"}\nLocal commit: ${result.localCommit ?? "none"}\nPatch package: ${result.patchPackage ?? "none"}\n\nPublication: **on hold; not performed**.\n`, "utf8");
  return status;
}

function phaseUsage(spec: TaskSpecV2, result: ImplementationExecutorResult): Record<string, unknown> {
  const empty = () => ({ startup: 0, analysis: 0, implementation: 0, validation: 0, repair: 0, review: 0, publication: 0 }); const provider = empty(), synthetic = empty();
  for (const call of result.providerCalls) { const phase = Number(call.iteration) === 0 ? "implementation" : "repair"; const target = call.usageAccounting === "synthetic" ? synthetic : provider; target[phase] += typeof call.tokenUsage === "number" ? call.tokenUsage : 0; }
  const phases = Object.fromEntries(Object.entries(provider).map(([phase, actualTokens]) => [phase, { actualTokens, requestedLimit: spec.execution.phaseBudgets[phase as keyof typeof provider], effectiveLimit: spec.execution.phaseBudgets[phase as keyof typeof provider], limitKind: spec.execution.budgetMode, exceeded: phase === result.budget.overrunPhase && result.budget.accounting === "provider" }]));
  return { accounting: "provider", providerCalls: result.providerCalls.filter((item) => item.usageAccounting !== "synthetic").length, totalTokens: Object.values(provider).reduce((sum, value) => sum + value, 0), costUsd: null, costAvailability: "provider_did_not_report_cost", phases, syntheticAccounting: { accounting: "synthetic", mixedWithProviderUsage: false, totalTokens: Object.values(synthetic).reduce((sum, value) => sum + value, 0), phases: Object.fromEntries(Object.entries(synthetic).map(([phase, actualTokens]) => [phase, { actualTokens, exceeded: phase === result.budget.overrunPhase && result.budget.accounting === "synthetic" }])) } };
}
function documentWorkflow(value: unknown): unknown { return value && typeof value === "object" ? (value as Record<string, unknown>).workflow : undefined; }
function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

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
    profile: executionPhaseOwner(spec.executionAgreement.profile, "localBranch", spec.executionAgreement.phaseOwnership) === "runforge" ? "local-ready" : "assist-only",
    summary: `RunForge implementation finished with '${result.status}' and workflow status '${status}'.`,
    changedFiles: result.changedFiles,
    patch: result.patchPackage ? "implementation.patch" : null,
    branch: result.localBranch,
    commit: result.localCommit,
    validation: result.validationResults.map((item) => ({
      command: item.command,
      status: item.outcome,
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

export function clearRepairedFindings(result: ImplementationExecutorResult): void {
  if (result.status === "implemented_and_validated" && result.validationResults.length > 0 && ["passed", "completed_with_validation_gaps"].includes(result.validationAggregate)) {
    result.unresolvedFindings = [];
  }
}
