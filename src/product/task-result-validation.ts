import {
  EXECUTION_PARTIES,
  EXECUTION_PHASE_IDS,
  EXECUTION_PROFILES,
  type ExecutionParty,
  type ExecutionPhaseId,
} from "./execution-agreement.js";

const RUNFORGE_COMPLETION_STATUSES = [
  "runforge_scope_completed", "workflow_completed", "awaiting_external_session", "awaiting_owner",
  "blocked_by_capability", "blocked_by_policy", "failed",
] as const;
const LEGACY_TASK_RESULT_STATUSES = [
  "completed", "failed", "awaiting_owner_decision", "blocked", "implementation_not_started", "no_change_required",
] as const;
const SYNTHETIC_TERMINAL_STATUSES = ["failed", "interrupted"] as const;
const EXECUTION_AGREEMENT_STATUSES = ["ready", "conflicted", "in_progress", "completed"] as const;
const DELEGATED_PARTIES = ["external_session", "owner", "external_system"] as const;
const AGREEMENT_ID_PATTERN = /^ea_v1_[a-f0-9]{24}$/;

export function validateTaskResultContract(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Task result must be an object.");
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== 1) throw new Error("Task result contract/version is invalid.");
  if (typeof result.taskId !== "string" || !result.taskId.trim()) throw new Error("Task result taskId is required.");
  if (result.contract === undefined) {
    validateSyntheticTerminalResult(result);
    return;
  }
  if (result.contract !== "runforge-task-result") throw new Error("Task result contract/version is invalid.");
  const agreementAware = result.agreement !== undefined || result.handoff !== undefined || result.next !== undefined;
  if (agreementAware) {
    if (typeof result.status !== "string" || !(RUNFORGE_COMPLETION_STATUSES as readonly string[]).includes(result.status)) throw new Error("Task result status is invalid.");
    for (const field of ["agreement", "handoff", "next"]) assertObject(result[field], `Task result ${field} must be an object.`);
    validateAgreementSummary(result.agreement as Record<string, unknown>);
    validateHandoff(result.handoff as Record<string, unknown>);
    validateNextAction(result.next as Record<string, unknown>, "Task result next");
    return;
  }
  if (typeof result.status !== "string" || !(LEGACY_TASK_RESULT_STATUSES as readonly string[]).includes(result.status)) throw new Error("Task result status is invalid.");
  for (const field of ["targetRepository", "artifacts", "ownerGate", "nextAction", "safetyAssertions"]) assertObject(result[field], `Task result ${field} must be an object.`);
  for (const field of ["completedWork", "validation", "errors", "limitations"]) if (!Array.isArray(result[field])) throw new Error(`Task result ${field} must be an array.`);
  const target = result.targetRepository as Record<string, unknown>;
  if (typeof target.changed !== "boolean") throw new Error("Task result targetRepository.changed must be boolean.");
  const safety = result.safetyAssertions as Record<string, unknown>;
  for (const field of ["targetMainMutation", "targetMainPush", "targetPrMerge", "deploy", "databaseAccess", "productionAccess", "secretAccess"]) {
    if (safety[field] !== false) throw new Error(`Task result safetyAssertions.${field} must be false.`);
  }
  if (typeof safety.providerCalls !== "boolean") throw new Error("Task result safetyAssertions.providerCalls must be boolean.");
}

function validateSyntheticTerminalResult(result: Record<string, unknown>): void {
  if (typeof result.status !== "string" || !(SYNTHETIC_TERMINAL_STATUSES as readonly string[]).includes(result.status)) throw new Error("Task result status is invalid.");
  for (const field of ["artifacts", "recovery", "safetyAssertions"]) assertObject(result[field], `Task result ${field} must be an object.`);
  const safety = result.safetyAssertions as Record<string, unknown>;
  if (safety.lateWorkerResultIgnored !== true) throw new Error("Task result safetyAssertions.lateWorkerResultIgnored must be true.");
  if (result.status === "failed") {
    assertObject(result.execution, "Task result execution must be an object.");
    if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Task result error is required.");
    if (typeof result.nextAction !== "string" || !result.nextAction.trim()) throw new Error("Task result nextAction is required.");
    if (safety.successNotInferred !== true) throw new Error("Task result safetyAssertions.successNotInferred must be true.");
    return;
  }
  for (const field of ["interruption", "targetMutation", "validations"]) assertObject(result[field], `Task result ${field} must be an object.`);
  if (result.execution !== undefined) assertObject(result.execution, "Task result execution must be an object.");
  if (result.nextAction !== undefined && typeof result.nextAction !== "string") assertObject(result.nextAction, "Task result nextAction must be a string or object.");
  if (safety.staleLeaseRevoked !== true) throw new Error("Task result safetyAssertions.staleLeaseRevoked must be true.");
  if (safety.providerCallsInferred !== false) throw new Error("Task result safetyAssertions.providerCallsInferred must be false.");
  if (safety.attemptArtifactsIsolated !== undefined && typeof safety.attemptArtifactsIsolated !== "boolean") throw new Error("Task result safetyAssertions.attemptArtifactsIsolated must be boolean.");
}

function validateAgreementSummary(value: Record<string, unknown>): void {
  if (typeof value.agreementId !== "string" || !AGREEMENT_ID_PATTERN.test(value.agreementId)) throw new Error("Task result agreement.agreementId is invalid.");
  if (!(EXECUTION_PROFILES as readonly unknown[]).includes(value.profile)) throw new Error("Task result agreement.profile is invalid.");
  if (!(EXECUTION_AGREEMENT_STATUSES as readonly unknown[]).includes(value.status)) throw new Error("Task result agreement.status is invalid.");
  for (const field of ["requestedProfile", "effectiveProfile"] as const) {
    if (value[field] !== undefined && !(EXECUTION_PROFILES as readonly unknown[]).includes(value[field])) throw new Error(`Task result agreement.${field} is invalid.`);
  }
  for (const field of ["phaseOwnership", "runforgeCompletedPhases", "delegatedPhases", "awaitingPhases"]) if (!Array.isArray(value[field])) throw new Error(`Task result agreement.${field} must be an array.`);

  const ownership = new Map<ExecutionPhaseId, ExecutionParty>();
  for (const [index, item] of (value.phaseOwnership as unknown[]).entries()) {
    assertObject(item, `Task result agreement.phaseOwnership[${index}] must be an object.`);
    const phaseId = validatePhaseId(item.phaseId, `agreement.phaseOwnership[${index}].phaseId`);
    if (!(EXECUTION_PARTIES as readonly unknown[]).includes(item.responsibleParty)) throw new Error(`Task result agreement.phaseOwnership[${index}].responsibleParty is invalid.`);
    if (ownership.has(phaseId)) throw new Error(`Task result agreement.phaseOwnership contains duplicate phase '${phaseId}'.`);
    ownership.set(phaseId, item.responsibleParty as ExecutionParty);
  }

  const completed = new Set<ExecutionPhaseId>();
  for (const [index, item] of (value.runforgeCompletedPhases as unknown[]).entries()) {
    const phaseId = validatePhaseId(item, `agreement.runforgeCompletedPhases[${index}]`);
    if (completed.has(phaseId)) throw new Error(`Task result agreement.runforgeCompletedPhases contains duplicate phase '${phaseId}'.`);
    if (ownership.get(phaseId) !== "runforge") throw new Error(`Task result agreement.runforgeCompletedPhases phase '${phaseId}' is not owned by runforge.`);
    completed.add(phaseId);
  }

  const delegated = validateOwnedPhaseSet(value.delegatedPhases as unknown[], "delegatedPhases", ownership);
  const awaiting = validateOwnedPhaseSet(value.awaitingPhases as unknown[], "awaitingPhases", ownership, true);
  for (const [phaseId, party] of awaiting) {
    if (delegated.get(phaseId) !== party) throw new Error(`Task result agreement.awaitingPhases phase '${phaseId}' must be delegated to the same party.`);
  }
}

function validateOwnedPhaseSet(
  items: unknown[], name: "delegatedPhases" | "awaitingPhases", ownership: ReadonlyMap<ExecutionPhaseId, ExecutionParty>, awaiting = false,
): Map<ExecutionPhaseId, ExecutionParty> {
  const phases = new Map<ExecutionPhaseId, ExecutionParty>();
  for (const [index, item] of items.entries()) {
    assertObject(item, `Task result agreement.${name}[${index}] must be an object.`);
    const phaseId = validatePhaseId(item.phaseId, `agreement.${name}[${index}].phaseId`);
    if (!(DELEGATED_PARTIES as readonly unknown[]).includes(item.responsibleParty)) throw new Error(`Task result agreement.${name}[${index}].responsibleParty is invalid.`);
    const party = item.responsibleParty as Exclude<ExecutionParty, "runforge" | "nobody">;
    if (phases.has(phaseId)) throw new Error(`Task result agreement.${name} contains duplicate phase '${phaseId}'.`);
    if (ownership.get(phaseId) !== party) throw new Error(`Task result agreement.${name} phase '${phaseId}' is inconsistent with phaseOwnership.`);
    if (awaiting && !Array.isArray(item.prerequisites)) throw new Error(`Task result agreement.${name}[${index}].prerequisites must be an array.`);
    phases.set(phaseId, party);
  }
  return phases;
}

function validatePhaseId(value: unknown, name: string): ExecutionPhaseId {
  if (!(EXECUTION_PHASE_IDS as readonly unknown[]).includes(value)) throw new Error(`Task result ${name} is invalid.`);
  return value as ExecutionPhaseId;
}

function validateHandoff(value: Record<string, unknown>): void {
  if (value.profile !== "assist-only" && value.profile !== "local-ready") throw new Error("Task result handoff.profile is invalid.");
  if (value.branch !== undefined) {
    if (value.profile === "assist-only" && value.branch !== null) throw new Error("Task result handoff.branch must be null for assist-only handoffs.");
    if (value.profile === "local-ready" && (typeof value.branch !== "string" || !value.branch.trim())) throw new Error("Task result handoff.branch is required for local-ready handoffs.");
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Task result handoff.summary is required.");
  for (const field of ["changedFiles", "validation", "findings", "risks", "nextActions", "publicationInstructions", "ciCommands"]) if (!Array.isArray(value[field])) throw new Error(`Task result handoff.${field} must be an array.`);
  if ((value.nextActions as unknown[]).length === 0) throw new Error("Task result handoff.nextActions must not be empty.");
  for (const [index, action] of (value.nextActions as unknown[]).entries()) {
    assertObject(action, `Task result handoff.nextActions[${index}] must be an object.`);
    validateNextAction(action as Record<string, unknown>, `Task result handoff.nextActions[${index}]`);
  }
  assertObject(value.safety, "Task result handoff.safety must be an object.");
  const safety = value.safety as Record<string, unknown>;
  for (const field of ["targetMainMutation", "targetMainPush", "targetPrMerge", "deploy", "databaseAccess", "productionAccess", "secretAccess"]) if (safety[field] !== false) throw new Error(`Task result handoff.safety.${field} must be false.`);
  if (typeof safety.providerCalls !== "boolean" || !Array.isArray(safety.notes)) throw new Error("Task result handoff.safety is incomplete.");
}

function validateNextAction(value: Record<string, unknown>, name: string): void {
  if (!["runforge", "external_session", "owner", "external_system"].includes(value.party as string)) throw new Error(`${name}.party is invalid.`);
  if (typeof value.exactAction !== "string" || !value.exactAction.trim()) throw new Error(`${name}.exactAction is required.`);
  if (!Array.isArray(value.gates) || !Array.isArray(value.evidence)) throw new Error(`${name} gates and evidence must be arrays.`);
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
}
