import { createHash } from "node:crypto";

export const EXECUTION_PHASE_IDS = [
  "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation",
  "localValidation", "independentReview", "repairIterations", "patchPackage",
  "localBranch", "localCommit", "remotePush", "draftPublication", "ciMonitoring",
  "ciRepair", "prReview", "merge", "deploy", "postDeployValidation", "dbAccess",
  "productionAccess", "secretUse", "providerModelCalls",
] as const;

export type ExecutionPhaseId = (typeof EXECUTION_PHASE_IDS)[number];

export const EXECUTION_PARTIES = ["runforge", "external_session", "owner", "external_system", "nobody"] as const;
export type ExecutionParty = (typeof EXECUTION_PARTIES)[number];

export const EXECUTION_PROFILES = ["assist-only", "local-ready", "draft-pr", "delivery", "custom"] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

// Named exports make consumers independent of the ordering of EXECUTION_PARTIES.
export const runforge: ExecutionParty = "runforge";
export const external_session: ExecutionParty = "external_session";
export const owner: ExecutionParty = "owner";
export const external_system: ExecutionParty = "external_system";
export const nobody: ExecutionParty = "nobody";

export type ExecutionPhaseStatus = "not_requested" | "ready" | "handoff" | "conflict" | "completed";
export type ExecutionAgreementStatus = "ready" | "conflicted" | "in_progress" | "completed";
export type ExecutionConflictKind = "unavailable" | "unauthorized" | "policy_denied";

export type PhaseBooleanMap = Partial<Record<ExecutionPhaseId, boolean>>;
export type PhasePartyMap = Partial<Record<ExecutionPhaseId, ExecutionParty>>;
export type PhaseStringListMap = Partial<Record<ExecutionPhaseId, readonly string[]>>;

export type ExecutionAgreementNegotiation = {
  profile: ExecutionProfile;
  /** What the caller wants done, independently of who should do it. */
  requested?: PhaseBooleanMap;
  /** Requested ownership overrides the selected profile. `nobody` means not requested. */
  requestedOwnership?: PhasePartyMap;
  /** What this RunForge installation can technically perform. */
  technicalCapability?: PhaseBooleanMap;
  /** What the owner has authorized RunForge to perform. */
  authority?: PhaseBooleanMap;
  /** What policy permits RunForge to perform. */
  policy?: PhaseBooleanMap;
  prerequisites?: PhaseStringListMap;
  completionEvidence?: PhaseStringListMap;
};

export type ExecutionPhaseAgreement = {
  phaseId: ExecutionPhaseId;
  requested: boolean;
  available: boolean;
  authorized: boolean;
  policyAllowed: boolean;
  responsibleParty: ExecutionParty;
  status: ExecutionPhaseStatus;
  reason: string;
  prerequisites: string[];
  completionEvidence: string[];
};

export type ExecutionAgreementConflict = {
  phaseId: ExecutionPhaseId;
  kind: ExecutionConflictKind;
  reason: string;
};

export type ExecutionHandoff = {
  phaseId: ExecutionPhaseId;
  responsibleParty: Exclude<ExecutionParty, "runforge" | "nobody">;
  reason: string;
  prerequisites: string[];
  completionEvidence: string[];
};

export type ExecutionAgreement = {
  schemaVersion: 1;
  agreementId: string;
  profile: ExecutionProfile;
  status: ExecutionAgreementStatus;
  phases: ExecutionPhaseAgreement[];
  conflicts: ExecutionAgreementConflict[];
  handoffs: ExecutionHandoff[];
  humanSummary: string;
};

const PROFILE_OWNERSHIP: Record<Exclude<ExecutionProfile, "custom">, PhasePartyMap> = {
  "assist-only": ownership({
    runforge: ["projectDiscovery", "taskAnalysis", "implementationPlanning", "providerModelCalls"],
    external_session: ["implementation", "localValidation", "independentReview", "repairIterations", "patchPackage"],
  }),
  "local-ready": ownership({
    runforge: ["projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation", "independentReview", "repairIterations", "patchPackage", "providerModelCalls"],
  }),
  "draft-pr": ownership({
    runforge: ["projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation", "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "remotePush", "draftPublication", "ciMonitoring", "ciRepair", "providerModelCalls"],
    owner: ["prReview"],
  }),
  delivery: ownership({
    runforge: ["projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation", "independentReview", "repairIterations", "patchPackage", "localBranch", "localCommit", "remotePush", "draftPublication", "ciMonitoring", "ciRepair", "providerModelCalls"],
    owner: ["prReview", "merge"],
    external_system: ["deploy", "postDeployValidation"],
  }),
};

/** Deterministically negotiates all 22 phases without conflating capability, authority, policy, or ownership. */
export function negotiateExecutionAgreement(input: ExecutionAgreementNegotiation): ExecutionAgreement {
  assertProfile(input.profile);
  validateKeys(input);
  const defaults = input.profile === "custom" ? {} : PROFILE_OWNERSHIP[input.profile];
  const phases = EXECUTION_PHASE_IDS.map((phaseId): ExecutionPhaseAgreement => {
    const responsibleParty = input.requestedOwnership?.[phaseId] ?? defaults[phaseId] ?? nobody;
    const requested = input.requested?.[phaseId] ?? responsibleParty !== nobody;
    const normalizedParty = requested ? responsibleParty : nobody;
    const available = input.technicalCapability?.[phaseId] ?? false;
    const authorized = input.authority?.[phaseId] ?? false;
    const policyAllowed = input.policy?.[phaseId] ?? false;
    const prerequisites = normalizeStrings(input.prerequisites?.[phaseId]);
    const completionEvidence = normalizeStrings(input.completionEvidence?.[phaseId]);
    const decision = decidePhase(phaseId, requested, normalizedParty, available, authorized, policyAllowed, completionEvidence);
    return { phaseId, requested, available, authorized, policyAllowed, responsibleParty: normalizedParty, ...decision, prerequisites, completionEvidence };
  });
  return assembleAgreement(input.profile, phases);
}

/** Returns a new agreement with evidence recorded; the stable ID changes only when contract data changes. */
export function completeExecutionPhase(agreement: ExecutionAgreement, phaseId: ExecutionPhaseId, evidence: readonly string[]): ExecutionAgreement {
  assertPhaseId(phaseId);
  const normalizedEvidence = normalizeStrings(evidence);
  if (normalizedEvidence.length === 0) throw new Error(`Completion evidence is required for phase '${phaseId}'.`);
  const current = agreement.phases.find((phase) => phase.phaseId === phaseId);
  if (!current?.requested) throw new Error(`Cannot complete unrequested phase '${phaseId}'.`);
  if (current.status === "conflict") throw new Error(`Cannot complete conflicted phase '${phaseId}'.`);
  const phases = agreement.phases.map((phase) => phase.phaseId === phaseId
    ? { ...phase, status: "completed" as const, reason: `Completed by ${phase.responsibleParty}; evidence recorded.`, completionEvidence: normalizedEvidence }
    : { ...phase, prerequisites: [...phase.prerequisites], completionEvidence: [...phase.completionEvidence] });
  return assembleAgreement(agreement.profile, phases);
}

/** Canonical handoffs are phase-ordered and contain no RunForge or unrequested work. */
export function normalizeExecutionHandoff(agreement: ExecutionAgreement): ExecutionHandoff[] {
  return agreement.phases.flatMap((phase): ExecutionHandoff[] => {
    if (!phase.requested || phase.status === "completed" || phase.responsibleParty === runforge || phase.responsibleParty === nobody) return [];
    return [{
      phaseId: phase.phaseId,
      responsibleParty: phase.responsibleParty as ExecutionHandoff["responsibleParty"],
      reason: phase.reason,
      prerequisites: normalizeStrings(phase.prerequisites),
      completionEvidence: normalizeStrings(phase.completionEvidence),
    }];
  });
}

export function renderExecutionAgreementSummary(agreement: Pick<ExecutionAgreement, "agreementId" | "profile" | "status" | "phases" | "conflicts" | "handoffs">): string {
  const requested = agreement.phases.filter((phase) => phase.requested).length;
  const completed = agreement.phases.filter((phase) => phase.status === "completed").length;
  const runforgeCount = agreement.phases.filter((phase) => phase.requested && phase.responsibleParty === runforge).length;
  return [
    `Execution Agreement ${agreement.agreementId} (${agreement.profile}): ${agreement.status}.`,
    `${requested} of ${EXECUTION_PHASE_IDS.length} phases requested; ${completed} completed; RunForge owns ${runforgeCount}.`,
    agreement.conflicts.length ? `Conflicts: ${agreement.conflicts.map((item) => `${item.phaseId} (${item.kind})`).join(", ")}.` : "Conflicts: none.",
    agreement.handoffs.length ? `Handoffs: ${agreement.handoffs.map((item) => `${item.phaseId} -> ${item.responsibleParty}`).join(", ")}.` : "Handoffs: none.",
  ].join("\n");
}

// Short aliases for callers that treat negotiation as construction and the summary as a renderer.
export const createExecutionAgreement = negotiateExecutionAgreement;
export const renderHumanSummary = renderExecutionAgreementSummary;

function decidePhase(phaseId: ExecutionPhaseId, requested: boolean, responsibleParty: ExecutionParty, available: boolean, authorized: boolean, policyAllowed: boolean, evidence: string[]): Pick<ExecutionPhaseAgreement, "status" | "reason"> {
  if (!requested || responsibleParty === nobody) return { status: "not_requested", reason: "Not requested." };
  if (evidence.length > 0) return { status: "completed", reason: `Completed by ${responsibleParty}; evidence recorded.` };
  if (responsibleParty !== runforge) return { status: "handoff", reason: `Delegated to ${responsibleParty}; tracked as a handoff.` };
  if (!available) return { status: "conflict", reason: `RunForge is responsible for ${phaseId}, but the technical capability is unavailable.` };
  if (!authorized) return { status: "conflict", reason: `RunForge is responsible for ${phaseId}, but authority was not granted.` };
  if (!policyAllowed) return { status: "conflict", reason: `RunForge is responsible for ${phaseId}, but policy denies execution.` };
  return { status: "ready", reason: "Requested, technically available, authorized, and permitted by policy." };
}

function assembleAgreement(profile: ExecutionProfile, phases: ExecutionPhaseAgreement[]): ExecutionAgreement {
  const conflicts = phases.flatMap((phase): ExecutionAgreementConflict[] => {
    if (phase.status !== "conflict") return [];
    const kind: ExecutionConflictKind = !phase.available ? "unavailable" : !phase.authorized ? "unauthorized" : "policy_denied";
    return [{ phaseId: phase.phaseId, kind, reason: phase.reason }];
  });
  const draft = { schemaVersion: 1 as const, profile, phases, conflicts };
  const agreementId = stableAgreementId(draft);
  const handoffs = normalizeExecutionHandoff({ ...draft, agreementId, status: "ready", handoffs: [], humanSummary: "" });
  const requested = phases.filter((phase) => phase.requested);
  const status: ExecutionAgreementStatus = conflicts.length > 0 ? "conflicted"
    : requested.length > 0 && requested.every((phase) => phase.status === "completed") ? "completed"
      : requested.some((phase) => phase.status === "completed") ? "in_progress" : "ready";
  const agreement: ExecutionAgreement = { ...draft, agreementId, status, handoffs, humanSummary: "" };
  agreement.humanSummary = renderExecutionAgreementSummary(agreement);
  return agreement;
}

function stableAgreementId(value: object): string {
  return `ea_v1_${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function ownership(groups: Partial<Record<ExecutionParty, readonly ExecutionPhaseId[]>>): PhasePartyMap {
  const result: PhasePartyMap = {};
  for (const party of EXECUTION_PARTIES) for (const phase of groups[party] ?? []) result[phase] = party;
  return result;
}

function normalizeStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function assertProfile(profile: string): asserts profile is ExecutionProfile {
  if (!(EXECUTION_PROFILES as readonly string[]).includes(profile)) throw new Error(`Unknown execution profile '${profile}'.`);
}

function assertPhaseId(phaseId: string): asserts phaseId is ExecutionPhaseId {
  if (!(EXECUTION_PHASE_IDS as readonly string[]).includes(phaseId)) throw new Error(`Unknown execution phase '${phaseId}'.`);
}

function validateKeys(input: ExecutionAgreementNegotiation): void {
  const maps: [string, Record<string, unknown> | undefined][] = [
    ["requested", input.requested], ["requestedOwnership", input.requestedOwnership],
    ["technicalCapability", input.technicalCapability], ["authority", input.authority], ["policy", input.policy],
    ["prerequisites", input.prerequisites], ["completionEvidence", input.completionEvidence],
  ];
  for (const [name, map] of maps) for (const phaseId of Object.keys(map ?? {})) {
    if (!(EXECUTION_PHASE_IDS as readonly string[]).includes(phaseId)) throw new Error(`Unknown phase '${phaseId}' in ${name}.`);
  }
}
