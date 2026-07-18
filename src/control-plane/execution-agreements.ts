import {
  EXECUTION_PARTIES,
  EXECUTION_PHASE_IDS,
  EXECUTION_PROFILES,
  negotiateExecutionAgreement,
  type ExecutionAgreement,
  type ExecutionAgreementNegotiation,
  type ExecutionParty,
  type ExecutionPhaseId,
  type PhaseBooleanMap,
} from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import { ControlPlaneError, type ControlAuthority } from "./contracts.js";

export const executionAgreementSchemaPath = "/schemas/execution-agreement-v1.schema.json" as const;
export const executionAgreementNegotiatePath = "/v1/execution-agreements/negotiate" as const;
export const executionAgreementPath = "/v1/execution-agreements/{id}" as const;
export const taskAgreementPath = "/v1/tasks/{id}/agreement" as const;

export type ExecutionAgreementNegotiationRequest = ExecutionAgreementNegotiation & { schemaVersion: 1 };

export const controlPlaneTechnicalCapabilities = phaseFlags([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

export const controlPlaneAgreementPolicy = phaseFlags([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

export function parseExecutionAgreementNegotiationRequest(value: unknown): ExecutionAgreementNegotiationRequest {
  const input = object(value, "execution agreement negotiation request");
  rejectUnknown(input, ["schemaVersion", "profile", "requested", "requestedOwnership", "technicalCapability", "authority", "policy", "prerequisites", "completionEvidence"], "execution agreement negotiation request");
  if (input.schemaVersion !== 1) throw new ControlPlaneError(400, "invalid_request", "schemaVersion must be 1.");
  const profile = choice(input.profile, EXECUTION_PROFILES, "profile");
  return {
    schemaVersion: 1,
    profile,
    ...optionalBooleanMap(input.requested, "requested"),
    ...optionalPartyMap(input.requestedOwnership),
    ...optionalBooleanMap(input.technicalCapability, "technicalCapability"),
    ...optionalBooleanMap(input.authority, "authority"),
    ...optionalBooleanMap(input.policy, "policy"),
    ...optionalStringListMap(input.prerequisites, "prerequisites"),
    ...optionalStringListMap(input.completionEvidence, "completionEvidence"),
  };
}

export const parseAgreementNegotiationRequest = parseExecutionAgreementNegotiationRequest;

export function negotiateControlPlaneAgreement(request: ExecutionAgreementNegotiationRequest): ExecutionAgreement {
  return negotiateExecutionAgreement({
    profile: request.profile,
    requested: request.requested,
    requestedOwnership: request.requestedOwnership,
    technicalCapability: narrowCapabilities(controlPlaneTechnicalCapabilities, request.technicalCapability),
    authority: narrowCapabilities(controlPlaneTechnicalCapabilities, request.authority),
    policy: narrowCapabilities(controlPlaneAgreementPolicy, request.policy),
    prerequisites: request.prerequisites,
    completionEvidence: request.completionEvidence,
  });
}

export function negotiateTaskAgreement(spec: TaskSpecV2, authority: ControlAuthority): ExecutionAgreement {
  const requested = spec.authority.allowProviderCalls ? undefined : { providerModelCalls: false };
  return negotiateExecutionAgreement({
    profile: spec.executionAgreement.profile,
    requested,
    requestedOwnership: spec.executionAgreement.phaseOwnership,
    technicalCapability: controlPlaneTechnicalCapabilities,
    authority: taskPhaseAuthority(authority),
    policy: controlPlaneAgreementPolicy,
  });
}

export function assertAgreementAccepted(agreement: ExecutionAgreement, taskId?: string): void {
  if (agreement.status !== "conflicted") return;
  throw new ControlPlaneError(409, "execution_agreement_conflict", "Execution Agreement contains RunForge phase conflicts; the task was not created.", {
    agreementId: agreement.agreementId,
    conflicts: agreement.conflicts,
    operation: "start_new_task",
    newTaskRequired: true,
  }, false, taskId);
}

export function assertAgreementMatchesTask(agreement: ExecutionAgreement, spec: TaskSpecV2, expected?: ExecutionAgreement): void {
  if (agreement.profile !== spec.executionAgreement.profile) {
    throw new ControlPlaneError(409, "execution_agreement_mismatch", `Stored agreement profile '${agreement.profile}' does not match TaskSpec profile '${spec.executionAgreement.profile}'.`, { agreementId: agreement.agreementId }, false, spec.taskId);
  }
  for (const [phaseId, party] of Object.entries(spec.executionAgreement.phaseOwnership ?? {})) {
    const phase = agreement.phases.find((item) => item.phaseId === phaseId);
    if (!phase || phase.responsibleParty !== party) {
      throw new ControlPlaneError(409, "execution_agreement_mismatch", `Stored agreement ownership for '${phaseId}' does not match the TaskSpec.`, { agreementId: agreement.agreementId }, false, spec.taskId);
    }
  }
  if (expected) for (const expectedPhase of expected.phases) {
    const phase = agreement.phases.find((item) => item.phaseId === expectedPhase.phaseId);
    if (!phase || phase.requested !== expectedPhase.requested || phase.responsibleParty !== expectedPhase.responsibleParty) {
      throw new ControlPlaneError(409, "execution_agreement_mismatch", `Stored agreement request for '${expectedPhase.phaseId}' does not match the TaskSpec.`, { agreementId: agreement.agreementId }, false, spec.taskId);
    }
  }
}

export function executionAgreementCapabilities(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    schemaUrl: executionAgreementSchemaPath,
    profiles: EXECUTION_PROFILES,
    phases: EXECUTION_PHASE_IDS,
    parties: EXECUTION_PARTIES,
    endpoints: { negotiate: executionAgreementNegotiatePath, agreement: executionAgreementPath, taskAgreement: taskAgreementPath },
    technicalCapabilities: controlPlaneTechnicalCapabilities,
    minimalRequest: { schemaVersion: 1, profile: "assist-only" },
  };
}

function taskPhaseAuthority(authority: ControlAuthority): PhaseBooleanMap {
  return {
    projectDiscovery: authority.inspect, taskAnalysis: authority.inspect, implementationPlanning: authority.inspect,
    implementation: authority.implementation, localValidation: authority.inspect, independentReview: authority.inspect,
    repairIterations: authority.implementation, patchPackage: authority.implementation, localBranch: authority.localBranch,
    localCommit: authority.localCommit, remotePush: authority.remotePush, draftPublication: authority.draftPublication,
    providerModelCalls: authority.providerCalls === true,
  };
}

function phaseFlags(enabled: readonly ExecutionPhaseId[]): Record<ExecutionPhaseId, boolean> {
  const selected = new Set<ExecutionPhaseId>(enabled);
  return Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, selected.has(phase)])) as Record<ExecutionPhaseId, boolean>;
}

function narrowCapabilities(base: Record<ExecutionPhaseId, boolean>, requested?: PhaseBooleanMap): Record<ExecutionPhaseId, boolean> {
  return Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, base[phase] && requested?.[phase] !== false])) as Record<ExecutionPhaseId, boolean>;
}

function optionalBooleanMap(value: unknown, name: "requested" | "technicalCapability" | "authority" | "policy"): Partial<ExecutionAgreementNegotiation> {
  if (value === undefined) return {};
  const input = phaseMap(value, name); const result: PhaseBooleanMap = {};
  for (const phase of EXECUTION_PHASE_IDS) if (input[phase] !== undefined) {
    if (typeof input[phase] !== "boolean") throw new ControlPlaneError(400, "invalid_request", `${name}.${phase} must be boolean.`);
    result[phase] = input[phase] as boolean;
  }
  return { [name]: result };
}

function optionalPartyMap(value: unknown): Partial<ExecutionAgreementNegotiation> {
  if (value === undefined) return {};
  const name = "requestedOwnership"; const input = phaseMap(value, name); const result: Partial<Record<ExecutionPhaseId, ExecutionParty>> = {};
  for (const phase of EXECUTION_PHASE_IDS) if (input[phase] !== undefined) result[phase] = choice(input[phase], EXECUTION_PARTIES, `${name}.${phase}`);
  return { requestedOwnership: result };
}

function optionalStringListMap(value: unknown, name: "prerequisites" | "completionEvidence"): Partial<ExecutionAgreementNegotiation> {
  if (value === undefined) return {};
  const input = phaseMap(value, name); const result: Partial<Record<ExecutionPhaseId, string[]>> = {};
  for (const phase of EXECUTION_PHASE_IDS) if (input[phase] !== undefined) {
    const values = input[phase];
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim())) throw new ControlPlaneError(400, "invalid_request", `${name}.${phase} must be an array of non-empty strings.`);
    result[phase] = values.map((item) => String(item).trim());
  }
  return { [name]: result };
}

function phaseMap(value: unknown, name: string): Record<string, unknown> {
  const input = object(value, name); const unknown = Object.keys(input).filter((phase) => !(EXECUTION_PHASE_IDS as readonly string[]).includes(phase));
  if (unknown.length) throw new ControlPlaneError(400, "unknown_fields", `${name} contains unknown phase(s): ${unknown.join(", ")}.`);
  return input;
}
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError(400, "invalid_request", `${name} must be an object.`); return value as Record<string, unknown>; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new ControlPlaneError(400, "unknown_fields", `${name} contains unknown field(s): ${unknown.join(", ")}.`); }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new ControlPlaneError(400, "invalid_request", `${name} must be one of: ${values.join(", ")}.`); return value as T; }
