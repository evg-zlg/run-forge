import {
  EXECUTION_PARTIES,
  EXECUTION_PHASE_IDS,
  EXECUTION_PROFILES,
  PUBLICATION_TARGET_KINDS,
  negotiateExecutionAgreement,
  type ExecutionAgreement,
  type ExecutionAgreementNegotiation,
  type ExecutionAgreementContext,
  type PublicationTarget,
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

export type ExecutionAgreementNegotiationRequest = Omit<ExecutionAgreementNegotiation, "context"> & {
  schemaVersion: 1;
  projectId?: string;
  publicationTarget?: PublicationTarget;
};

export const controlPlaneTechnicalCapabilities = phaseFlags([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

export const controlPlaneAgreementPolicy = phaseFlags([
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
  "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
]);

export function parseExecutionAgreementNegotiationRequest(value: unknown): ExecutionAgreementNegotiationRequest {
  assertCredentialFreeNegotiationInput(value);
  const input = object(value, "execution agreement negotiation request");
  rejectUnknown(input, ["schemaVersion", "profile", "projectId", "publicationTarget", "requested", "requestedOwnership", "technicalCapability", "authority", "policy", "prerequisites", "completionEvidence"], "execution agreement negotiation request");
  if (input.schemaVersion !== 1) throw new ControlPlaneError(400, "invalid_request", "schemaVersion must be 1.");
  const profile = choice(input.profile, EXECUTION_PROFILES, "profile");
  return {
    schemaVersion: 1,
    profile,
    ...(input.projectId === undefined ? {} : { projectId: nonEmptyString(input.projectId, "projectId") }),
    publicationTarget: parsePublicationTarget(input.publicationTarget),
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

export function negotiateControlPlaneAgreement(
  request: ExecutionAgreementNegotiationRequest,
  installationCapability: Record<ExecutionPhaseId, boolean> = controlPlaneTechnicalCapabilities,
  context?: ExecutionAgreementContext,
): ExecutionAgreement {
  const targeted = publicationRequest(request);
  return negotiateExecutionAgreement({
    profile: request.profile,
    requested: targeted.requested,
    requestedOwnership: targeted.ownership,
    technicalCapability: narrowCapabilities(installationCapability, request.technicalCapability),
    authority: explicitPhaseAuthority(request.authority),
    policy: narrowCapabilities(controlPlaneAgreementPolicy, request.policy),
    prerequisites: request.prerequisites,
    completionEvidence: request.completionEvidence,
    context,
  });
}

export function negotiateTaskAgreement(spec: TaskSpecV2, authority: ControlAuthority, context?: ExecutionAgreementContext): ExecutionAgreement {
  const requested = requestedPhasesForMode(spec);
  return negotiateExecutionAgreement({
    profile: spec.executionAgreement.profile,
    requested,
    requestedOwnership: spec.executionAgreement.phaseOwnership,
    technicalCapability: controlPlaneTechnicalCapabilities,
    authority: taskPhaseAuthority(authority),
    policy: controlPlaneAgreementPolicy,
    context,
  });
}

function requestedPhasesForMode(spec: TaskSpecV2): PhaseBooleanMap | undefined {
  if (["implementation", "repair"].includes(spec.execution.mode)) {
    return spec.authority.allowProviderCalls ? undefined : { providerModelCalls: false };
  }
  const allowed = new Set<ExecutionPhaseId>(spec.execution.mode === "inspection"
    ? ["projectDiscovery", "taskAnalysis"]
    : ["projectDiscovery", "taskAnalysis", "localValidation"]);
  return Object.fromEntries(EXECUTION_PHASE_IDS.filter((phase) => !allowed.has(phase)).map((phase) => [phase, false])) as PhaseBooleanMap;
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
    const expectedPhase = expected?.phases.find((item) => item.phaseId === phaseId);
    if (expectedPhase && !expectedPhase.requested) continue;
    const phase = agreement.phases.find((item) => item.phaseId === phaseId);
    if (!phase || phase.responsibleParty !== party) {
      throw new ControlPlaneError(409, "execution_agreement_mismatch", `Stored agreement ownership for '${phaseId}' does not match the TaskSpec.`, { agreementId: agreement.agreementId }, false, spec.taskId);
    }
  }
  if (expected) for (const expectedPhase of expected.phases) {
    const phase = agreement.phases.find((item) => item.phaseId === expectedPhase.phaseId);
    const expectedRequested = taskExpectedPhaseRequested(agreement, spec, expectedPhase.phaseId, expectedPhase.requested, agreement.agreementId !== expected.agreementId);
    const expectedParty = expectedRequested ? expectedPhase.responsibleParty : "nobody";
    if (!phase || phase.requested !== expectedRequested || phase.responsibleParty !== expectedParty) {
      throw new ControlPlaneError(409, "execution_agreement_mismatch", `Stored agreement request for '${expectedPhase.phaseId}' does not match the TaskSpec.`, { agreementId: agreement.agreementId }, false, spec.taskId);
    }
  }
}

function taskExpectedPhaseRequested(
  agreement: ExecutionAgreement,
  spec: TaskSpecV2,
  phaseId: ExecutionPhaseId,
  requested: boolean,
  referencedAgreement: boolean,
): boolean {
  const target = agreement.context?.publicationTarget;
  if (!referencedAgreement || target?.kind !== "none" || !["assist-only", "local-ready"].includes(spec.executionAgreement.profile)) return requested;
  return (["remotePush", "draftPublication", "ciMonitoring", "ciRepair"] as readonly ExecutionPhaseId[]).includes(phaseId) ? false : requested;
}

export function executionAgreementCapabilities(
  technicalCapabilities: Record<ExecutionPhaseId, boolean> = controlPlaneTechnicalCapabilities,
  readiness: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    schemaUrl: executionAgreementSchemaPath,
    profiles: EXECUTION_PROFILES,
    phases: EXECUTION_PHASE_IDS,
    parties: EXECUTION_PARTIES,
    endpoints: { negotiate: executionAgreementNegotiatePath, agreement: executionAgreementPath, taskAgreement: taskAgreementPath },
    projectLevelNegotiation: true,
    publicationTargetKinds: PUBLICATION_TARGET_KINDS,
    technicalCapabilities,
    readiness,
    unavailableAdapters: unavailableAdapters(),
    minimalRequest: {
      schemaVersion: 1,
      profile: "assist-only",
      projectId: "<registered-project-id>",
      publicationTarget: { kind: "none" },
      authority: phaseFlags([
        "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation",
        "repairIterations", "patchPackage", "providerModelCalls",
      ]),
    },
  };
}

export function technicalCapabilitiesForExecutor(ready: boolean): Record<ExecutionPhaseId, boolean> {
  return phaseFlags([
    "projectDiscovery", "taskAnalysis", "implementationPlanning", ...(ready ? ["implementation" as const] : []),
    "localValidation", "independentReview", ...(ready ? ["repairIterations" as const] : []), "patchPackage",
    "localBranch", "localCommit", ...(ready ? ["providerModelCalls" as const] : []),
  ]);
}

export function unavailableAdapters(): Record<string, { available: false; credentialReady: false; reason: string }> {
  const adapter = (reason: string) => ({ available: false as const, credentialReady: false as const, reason });
  return {
    githubPush: adapter("No GitHub push adapter is implemented."), githubPullRequest: adapter("No GitHub pull-request create or update adapter is implemented."),
    gitlabPush: adapter("No GitLab push adapter is implemented."), gitlabMergeRequest: adapter("No GitLab merge-request create or update adapter is implemented."),
    updateExistingChange: adapter("No existing PR, MR, or change update adapter is implemented."), ci: adapter("No CI adapter is implemented."),
    merge: adapter("No merge adapter is implemented."), deploy: adapter("No deploy adapter is implemented."), database: adapter("No database adapter is implemented."),
    production: adapter("No production adapter is implemented."), secrets: adapter("No secret adapter is implemented and credentials are never returned."),
  };
}

function publicationRequest(request: ExecutionAgreementNegotiationRequest): { requested: PhaseBooleanMap | undefined; ownership: ExecutionAgreementNegotiation["requestedOwnership"] } {
  const requested = { ...(request.requested ?? {}) };
  const ownership = { ...(request.requestedOwnership ?? {}) };
  const target = request.publicationTarget ?? { kind: "none" };
  if (target.kind === "none") {
    // A publication profile cannot be made adapter-ready by silently removing
    // the phases that define it. Callers wanting local-only work must choose a
    // local profile (or explicitly model custom ownership) instead.
    if (request.profile !== "draft-pr" && request.profile !== "delivery") {
      for (const phase of ["remotePush", "draftPublication", "ciMonitoring", "ciRepair"] as const) requested[phase] = false;
    }
  } else if (target.kind === "new_branch") {
    requested.localBranch = true;
  } else if (target.kind === "existing_branch") {
    requested.localBranch = false;
  } else {
    requested.remotePush = true; requested.draftPublication = true;
    if (target.kind === "externally_managed_existing_change") {
      ownership.remotePush ??= target.responsibleParty;
      ownership.draftPublication ??= target.responsibleParty;
      requested.ciMonitoring ??= false;
      requested.ciRepair ??= false;
    }
  }
  return { requested, ownership };
}

function parsePublicationTarget(value: unknown): PublicationTarget {
  if (value === undefined) return { kind: "none" };
  const input = object(value, "publicationTarget");
  const kind = choice(input.kind, PUBLICATION_TARGET_KINDS, "publicationTarget.kind");
  if (kind === "none") { rejectUnknown(input, ["kind"], "publicationTarget"); return { kind }; }
  if (kind === "new_branch" || kind === "existing_branch") {
    rejectUnknown(input, ["kind", "branchName"], "publicationTarget");
    return { kind, branchName: nonEmptyString(input.branchName, "publicationTarget.branchName") };
  }
  if (kind === "existing_change") {
    rejectUnknown(input, ["kind", "provider", "changeId"], "publicationTarget");
    return { kind, provider: choice(input.provider, ["github", "gitlab", "other"], "publicationTarget.provider"), changeId: nonEmptyString(input.changeId, "publicationTarget.changeId") };
  }
  rejectUnknown(input, ["kind", "provider", "changeId", "responsibleParty"], "publicationTarget");
  return { kind, provider: choice(input.provider, ["github", "gitlab", "other"], "publicationTarget.provider"), changeId: nonEmptyString(input.changeId, "publicationTarget.changeId"), responsibleParty: choice(input.responsibleParty, ["external_session", "external_system", "owner"], "publicationTarget.responsibleParty") };
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

function explicitPhaseAuthority(authority?: PhaseBooleanMap): Record<ExecutionPhaseId, boolean> {
  return Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, authority?.[phase] === true])) as Record<ExecutionPhaseId, boolean>;
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
function assertCredentialFreeNegotiationInput(value: unknown): void {
  const pending: unknown[] = [value]; const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && credentialLikeText(current)) credentialInputError();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) { pending.push(...current); continue; }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      const executionPhaseKey = (EXECUTION_PHASE_IDS as readonly string[]).includes(key);
      if ((!executionPhaseKey && credentialLikeKey(key)) || credentialLikeText(key)) credentialInputError();
      pending.push(item);
    }
  }
}
function credentialLikeKey(value: string): boolean { return /(?:authorization|credential|password|private[_-]?key|secret|token|api[_-]?key)/i.test(value); }
function credentialLikeText(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bglpat-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?[^\s"',;]{8,}/i.test(value);
}
function credentialInputError(): never { throw new ControlPlaneError(400, "credential_material_forbidden", "Execution Agreement negotiation requests must not contain credentials or tokens."); }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError(400, "invalid_request", `${name} must be an object.`); return value as Record<string, unknown>; }
function nonEmptyString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} must be a non-empty string.`); return value.trim(); }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new ControlPlaneError(400, "unknown_fields", `${name} contains unknown field(s): ${unknown.join(", ")}.`); }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new ControlPlaneError(400, "invalid_request", `${name} must be one of: ${values.join(", ")}.`); return value as T; }
