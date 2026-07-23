import { randomUUID } from "node:crypto";
import type { ExecutionAgreement, ExecutionAgreementConflict, ExecutionParty, ExecutionPhaseId, ExecutionProfile } from "../product/execution-agreement.js";
import { normalizeProviderModelPools, type ProviderModelPools, type ProviderRoutingPhase } from "../product/provider-routing.js";
import type { ValidationCapabilityNegotiation } from "./validation-negotiation.js";
export const controlPlaneApiVersion = "v1";
export const defaultControlPlaneHost = "127.0.0.1";
export const defaultControlPlanePort = 7373;
export const defaultMaxRequestBytes = 1_048_576;
export type ControlAuthority = {
  inspect: boolean;
  implementation: boolean;
  providerCalls?: boolean;
  network?: boolean;
  localBranch: boolean;
  localCommit: boolean;
  remotePush: boolean;
  draftPublication: boolean;
  merge: boolean;
  deploy: boolean;
};
export type CheckpointResumeRequest = {
  artifactRoot: string; projectId: string; targetRepository: string; workingDirectory: string;
  expectedBaseSha: string; executionAgreementId: string; authoritySnapshot: Record<string, unknown>;
  candidateBinary: { path: string; sha256: string; sourceRunforgeSha: string; minimumCheckpointSchemaVersion: number; maximumCheckpointSchemaVersion: number; features: string[] };
  dependency: { strategy: "verified_read_only_cache" | "candidate_local_offline_install" | "no_dependencies"; cacheRoot?: string; cacheSha256?: string; packageManager?: "npm" | "pnpm" | "yarn" | "bun" };
};
export type ProjectRecord = {
  id: string;
  repository: string;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
};
export type ControlTaskStatus = "queued" | "running" | "awaiting_owner_decision" | "continuing" | "completed" | "failed" | "interrupted";

export type DecisionRecord = {
  decisionId: string;
  kind: "owner" | "publication" | "accept_completed" | "discard_result" | "checkpoint_repair";
  decision: string;
  createdAt: string;
  response: Record<string, unknown>;
};
export type TaskProgress = {
  phase: string;
  operation: string;
  startedAt: string | null;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  executionId: string | null;
  attempt: number;
  workerStatus: "idle" | "starting" | "active" | "slow" | "finished" | "failed" | "lost" | "stalled" | "cancelled" | "revoked";
  timeoutMs: number;
  deadlineAt: string | null;
  summary: string;
  diagnostic: string | null;
  agreement?: AgreementLifecycleProjection;
};
export type AgreementLifecycleProjection = {
  schemaVersion: 1;
  agreementId: string;
  profile: ExecutionProfile;
  currentPhase: ExecutionPhaseId | null;
  responsibleParty: ExecutionParty | null;
  runforgeCompletedPhases: ExecutionPhaseId[];
  delegatedPhases: Array<{ phaseId: ExecutionPhaseId; responsibleParty: Exclude<ExecutionParty, "runforge" | "nobody"> }>;
  awaitingPhases: Array<{ phaseId: ExecutionPhaseId; responsibleParty: Exclude<ExecutionParty, "runforge" | "nobody">; prerequisites: string[] }>;
  nextParty: Exclude<ExecutionParty, "nobody"> | null;
  nextAction: string | null;
  conflicts: ExecutionAgreementConflict[];
  ownerGate: { required: boolean; status: string; reason?: string };
  publicationGate: { required: boolean; status: string; reason?: string };
};
export type TaskRecovery = {
  reason: string;
  lastPhase: string;
  lastHeartbeatAt: string | null;
  originalExecutionId: string | null;
  actions: string[];
  retryAvailable: boolean;
  retryAfter?: string;
  cleanupStatus: "not_required" | "pending" | "completed" | "detached";
  operation?: string;
  prerequisites?: string[];
  newTaskRequired?: boolean;
  previousArtifactsReusable?: boolean;
  targetShaChanged?: boolean | null;
  code?: string;
  workspaceSetup?: { path: string; expectedTarget: string; actualTarget: string | null; owner: Record<string, unknown> | null };
} | null;

export type ExecutionLease = {
  executionId: string;
  attempt: number;
  operation: "execution" | "continuation";
  state: "active" | "revoked" | "finished";
  startedAt: string;
  revokedAt: string | null;
  cleanupDeadlineAt: string | null;
};
export type ExecutionAttempt = {
  executionId: string;
  attempt: number;
  operation: "execution" | "continuation";
  artifactRoot: string;
  specPath: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "active" | "completed" | "failed" | "interrupted";
};
export type ControlTaskRecord = {
  id: string;
  projectId: string | null;
  status: ControlTaskStatus;
  specPath: string;
  artifactRoot: string;
  executionAgreement?: ExecutionAgreement;
  validationNegotiation?: ValidationCapabilityNegotiation;
  authority: ControlAuthority;
  publicationRequested: "none" | "draft-pr";
  publicationGate: { required: boolean; status: string; reason?: string };
  ownerGate: { required: boolean; status: string; reason?: string };
  timeout?: { requestedMs: number; effectiveMs: number; limitingSource: "requested" | "control_plane_cap" | "executor_cap"; phaseDeadlines: Record<string, { timeoutMs: number; deadlineAt: string }>; watchdogPolicy: string };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  decisions: DecisionRecord[];
  events: Array<{ at: string; type: string; detail?: string }>;
  progress: TaskProgress;
  recovery: TaskRecovery;
  execution: {
    attempt: number;
    lease: ExecutionLease | null;
    attempts: ExecutionAttempt[];
    lastRetry: { sourceExecutionId: string; executionId: string; requestedAt: string } | null;
  };
  continuation: { schemaVersion: 1; state: "none" | "available" | "consumed" | "unrecoverable"; decisionId: string | null; executionId: string | null; sourceExecutionId: string | null };
  checkpointRepair?: { schemaVersion: 1; decisionId: string; checkpointId: string; checkpointDigest: string; checkpointArtifactRoot: string; checkpointPatchPath: string; baseSha: string; executionAgreementId: string; choice: "grant_additional_budget" | "retry_from_checkpoint"; additionalProviderTokens: number; repairIntent: string | null; sourceExecutionId: string; repairExecutionId: string | null };
  selection?: {
    requestedMode: string; normalizedMode: string; selectedExecutor: string | null; selectedRuntime: string | null;
    selectionReason: string; rejectedAlternatives: Array<{ id: string; reason: string }>;
    authorityChecks: Record<string, boolean>; providerDecision: string; networkDecision: string;
    provider: string | null; model: string | null;
    /** Routing is declarative and intentionally excludes credential references and headers. */
    requestedProvider?: "local" | "openrouter" | null;
    effectiveProvider?: "local" | "openrouter" | null;
    phaseModels?: Partial<Record<ProviderRoutingPhase, string>>;
    modelPools?: ProviderModelPools;
    fallbackPolicy?: "none" | "same_provider";
    noLocalFallback?: boolean;
    /** Provider-backed semantic review route reserved during task preflight. */
    semanticReview?: { schemaVersion: 1; outcome: "preflight_contract_rejected" | "semantic_review_negotiated"; runtime: string; reviewer: { required: boolean; provider: "openrouter" | "local" | null; model: string | null } };
    budgets?: { maxCalls: number; tokenBudget: { total: number; perPhase: Record<ProviderRoutingPhase, number> }; costBudgetUsd?: number; timeoutMs: number; maxAttempts: number };
  };
};

export type CampaignStatus = "planning" | "queued" | "running" | "completed" | "failed" | "on_hold";
export type CampaignProviderRouting = {
  provider: "openrouter" | "local";
  model?: string;
  /** Legacy phase-specific single-model configuration. */
  phaseModels?: Partial<Record<ProviderRoutingPhase, string>>;
  /** Ordered candidates chosen deterministically from a campaign-stable key. */
  modelPools?: ProviderModelPools;
  fallbackPolicy?: "none" | "same_provider";
};
/** Caller-supplied known checks; campaign planning never infers a complete arbitrary-project suite. */
export type CampaignValidationContract = {
  source: "explicit" | "task_spec" | "doctor" | "project_profile";
  requiredCommands: string[];
};
export type CampaignSpec = {
  goal: string;
  target: { projectId?: string; repository?: string; workingDirectory?: string; expectedSha?: string };
  authority: ControlAuthority;
  providerRouting: CampaignProviderRouting;
  limits: { maxCostUsd?: number; maxTokens: number; maxTasks: number; maxConcurrency: number };
  /** Optional for read-only campaigns. Required before an implementation campaign can run. */
  validationContract?: CampaignValidationContract;
};
export type CampaignPlanNode = {
  id: string;
  taskSpec: Record<string, unknown>;
  dependsOn: string[];
  writeScopes?: string[];
  estimatedTokens?: number;
  estimatedCostUsd?: number;
};
export type CampaignPlan = {
  schemaVersion: 1;
  campaignId: string;
  nodes: CampaignPlanNode[];
  estimatedTokens: number;
  estimatedCostUsd?: number;
};
export type CampaignRecord = {
  schemaVersion: 1;
  id: string;
  status: CampaignStatus;
  spec: CampaignSpec;
  plan: CampaignPlan | null;
  plannerEvidence: Record<string, unknown> | null;
  integration: null | { status: "ready" | "failed"; worktreeRoot: string; branch: string; baseSha: string; headSha: string; appliedNodes: string[]; repairAttempts: number; lastError: string | null };
  children: Record<string, {
    nodeId: string;
    dependsOn: string[];
    taskId: string | null;
    /** `dispatching` is durable: a restart reconciles its deterministic task id before re-dispatching. */
    status: "pending" | "dispatching" | "queued" | "running" | "completed" | "failed" | "blocked";
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    accounted: boolean;
    /** Persisted estimate held while a child can still consume provider budget. */
    reservedTokens: number;
    reservedCostUsd: number;
    integrationRepairAttempts: number;
    executionRetryAttempts: number;
    evidence?: Record<string, unknown>; checkpointRepair?: { state: "pending" | "started"; taskId: string; decisionId: string; checkpointId: string; checkpointDigest: string; additionalProviderTokens: number; repairIntent: string };
  }>;
  usage: { tokens: number; costUsd: number; tasks: number };
  /** Sum of child reservations that have not yet been converted to actual usage. */
  reserved: { tokens: number; costUsd: number };
  checkpoints: string[];
  failures: Array<{ at: string; nodeId?: string; taskId?: string; reason: string }>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};
export function parseCampaignRequest(value: unknown): CampaignSpec {
  const input = asObject(value, "campaign request");
  rejectUnknown(input, ["goal", "target", "authority", "providerRouting", "limits", "validationContract"], "campaign request");
  const target = asObject(input.target, "target");
  rejectUnknown(target, ["projectId", "repository", "workingDirectory", "expectedSha"], "target");
  const routing = asObject(input.providerRouting, "providerRouting");
  rejectUnknown(routing, ["provider", "model", "phaseModels", "modelPools", "fallbackPolicy"], "providerRouting");
  const phaseModels = asObject(routing.phaseModels, "providerRouting.phaseModels", true);
  rejectUnknown(phaseModels, ["planner", "implementer", "repair", "reviewer", "logCompression"], "providerRouting.phaseModels");
  let modelPools: ProviderModelPools;
  try { modelPools = normalizeProviderModelPools(routing.modelPools, "providerRouting.modelPools"); }
  catch (error) { throw new ControlPlaneError(400, "invalid_request", error instanceof Error ? error.message : "providerRouting.modelPools is invalid."); }
  const limits = asObject(input.limits, "limits");
  rejectUnknown(limits, ["maxCostUsd", "maxTokens", "maxTasks", "maxConcurrency"], "limits");
  const validation = asObject(input.validationContract, "validationContract", true);
  rejectUnknown(validation, ["source", "requiredCommands"], "validationContract");
  const requiredCommands = stringArray(validation.requiredCommands, "validationContract.requiredCommands");
  if (Object.keys(validation).length && !requiredCommands.length) throw new ControlPlaneError(400, "invalid_request", "validationContract.requiredCommands must contain at least one command.");
  const validationContract = Object.keys(validation).length
    ? { source: choice(validation.source, ["explicit", "task_spec", "doctor", "project_profile"] as const, "validationContract.source"), requiredCommands: [...new Set(requiredCommands)] }
    : undefined;
  const fallbackPolicy = routing.fallbackPolicy === undefined
    ? undefined
    : choice(routing.fallbackPolicy, ["none", "same_provider"] as const, "providerRouting.fallbackPolicy");
  return { goal: string(input.goal, "goal"), target: { ...(target.projectId === undefined ? {} : { projectId: string(target.projectId, "target.projectId") }), ...(target.repository === undefined ? {} : { repository: string(target.repository, "target.repository") }), ...(target.workingDirectory === undefined ? {} : { workingDirectory: string(target.workingDirectory, "target.workingDirectory") }), ...(target.expectedSha === undefined ? {} : { expectedSha: string(target.expectedSha, "target.expectedSha") }) }, authority: defaultAuthority(input.authority), providerRouting: { provider: choice(routing.provider, ["openrouter", "local"] as const, "providerRouting.provider"), ...(routing.model === undefined ? {} : { model: string(routing.model, "providerRouting.model") }), ...(Object.keys(phaseModels).length ? { phaseModels: Object.fromEntries(Object.entries(phaseModels).map(([k, v]) => [k, string(v, `providerRouting.phaseModels.${k}`)])) as CampaignProviderRouting["phaseModels"] } : {}), ...(Object.keys(modelPools).length ? { modelPools } : {}), ...(fallbackPolicy === undefined ? {} : { fallbackPolicy }) }, limits: { ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: decimal(limits.maxCostUsd, "limits.maxCostUsd", 0.000_001, 1_000_000) }), maxTokens: integer(limits.maxTokens, "limits.maxTokens", 1, 200_000), maxTasks: integer(limits.maxTasks, "limits.maxTasks", 1, 100), maxConcurrency: integer(limits.maxConcurrency, "limits.maxConcurrency", 1, 20) }, ...(validationContract ? { validationContract } : {}) };
}
export function defaultAuthority(value: unknown): ControlAuthority {
  const input = asObject(value, "authority", true);
  const allowed = ["inspect", "implementation", "providerCalls", "network", "localBranch", "localCommit", "remotePush", "draftPublication", "merge", "deploy"];
  rejectUnknown(input, allowed, "authority");
  const flag = (name: string, fallback: boolean) => input[name] === undefined ? fallback : boolean(input[name], `authority.${name}`);
  const authority = {
    inspect: flag("inspect", true), implementation: flag("implementation", false), providerCalls: flag("providerCalls", false), network: flag("network", false), localBranch: flag("localBranch", false),
    localCommit: flag("localCommit", false), remotePush: flag("remotePush", false), draftPublication: flag("draftPublication", false),
    merge: flag("merge", false), deploy: flag("deploy", false)
  };
  if (authority.localCommit && !authority.localBranch) throw new ControlPlaneError(422, "invalid_authority", "localCommit requires localBranch authority.");
  if (authority.remotePush && !authority.localCommit) throw new ControlPlaneError(422, "invalid_authority", "remotePush requires localCommit authority.");
  if (authority.draftPublication && !authority.remotePush) throw new ControlPlaneError(422, "invalid_authority", "draftPublication requires remotePush authority.");
  if (authority.merge || authority.deploy) throw new ControlPlaneError(422, "hard_boundary", "Merge and deploy are not executable through the local control plane.");
  return authority;
}

export function parseProjectRequest(value: unknown): { path: string; workingDirectory: string; register: boolean; runtime?: "local" | "docker"; dependencyPreparation?: "required" | "if-needed" | "disabled" | "reuse-existing" } {
  const input = asObject(value, "project request");
  rejectUnknown(input, ["path", "workingDirectory", "register", "runtime", "dependencyPreparation"], "project request");
  const runtime = optionalChoice(input.runtime, ["local", "docker"], "runtime");
  const dependencyPreparation = optionalChoice(input.dependencyPreparation, ["required", "if-needed", "disabled", "reuse-existing"], "dependencyPreparation");
  return { path: string(input.path, "path"), workingDirectory: optionalString(input.workingDirectory, "workingDirectory") ?? ".", register: optionalBoolean(input.register, "register") ?? true, ...(runtime ? { runtime } : {}), ...(dependencyPreparation ? { dependencyPreparation } : {}) };
}

export function parseTaskRequest(value: unknown): { projectId?: string; taskSpec: Record<string, unknown>; authority: ControlAuthority; publicationRequested: "none" | "draft-pr"; agreementId?: string } {
  const input = asObject(value, "task request");
  rejectUnknown(input, ["projectId", "taskSpec", "authority", "publication", "agreementId", "executionAgreementId"], "task request");
  if (input.agreementId !== undefined && input.executionAgreementId !== undefined) throw new ControlPlaneError(400, "invalid_request", "Use agreementId or executionAgreementId, not both.");
  const taskSpec = asObject(input.taskSpec, "taskSpec");
  const publication = input.publication === undefined ? "none" : choice(input.publication, ["none", "draft-pr"], "publication");
  const agreementId = input.agreementId ?? input.executionAgreementId;
  const normalizedAgreementId = agreementId === undefined ? undefined : string(agreementId, "agreementId");
  if (normalizedAgreementId && !/^ea_v1_[a-f0-9]{24}$/.test(normalizedAgreementId)) throw new ControlPlaneError(400, "invalid_request", "agreementId must be a RunForge Execution Agreement v1 identifier.");
  return { ...(input.projectId === undefined ? {} : { projectId: string(input.projectId, "projectId") }), taskSpec, authority: defaultAuthority(input.authority), publicationRequested: publication, ...(normalizedAgreementId === undefined ? {} : { agreementId: normalizedAgreementId }) };
}

export function parseDecisionRequest(value: unknown, kind: "owner" | "publication"): { decisionId: string; decision: string; targetBranch?: string; note: string } {
  const input = asObject(value, `${kind} decision`);
  rejectUnknown(input, ["decisionId", "decision", "targetBranch", "note"], `${kind} decision`);
  const decision = choice(input.decision, kind === "owner" ? ["approve", "reject", "continue", "hold"] : ["approve", "reject", "hold"], "decision");
  return { decisionId: optionalString(input.decisionId, "decisionId") ?? randomUUID(), decision, ...(input.targetBranch === undefined ? {} : { targetBranch: string(input.targetBranch, "targetBranch") }), note: string(input.note, "note") };
}

export function parseAcceptCompletedRequest(value: unknown): { decisionId: string; checkpointId: string; delivery: "patch" | "local_commit" } {
  const input = asObject(value, "accept completed result");
  rejectUnknown(input, ["decisionId", "checkpointId", "delivery"], "accept completed result");
  return { decisionId: optionalString(input.decisionId, "decisionId") ?? randomUUID(), checkpointId: string(input.checkpointId, "checkpointId"), delivery: choice(input.delivery ?? "patch", ["patch", "local_commit"], "delivery") };
}
export function parseCheckpointResumeRequest(value: unknown): CheckpointResumeRequest {
  const input = asObject(value, "checkpoint resume");
  rejectUnknown(input, ["artifactRoot", "projectId", "targetRepository", "workingDirectory", "expectedBaseSha", "executionAgreementId", "authoritySnapshot", "candidateBinary", "dependency"], "checkpoint resume");
  const binary = asObject(input.candidateBinary, "candidateBinary"), dependency = asObject(input.dependency, "dependency");
  rejectUnknown(binary, ["path", "sha256", "sourceRunforgeSha", "minimumCheckpointSchemaVersion", "maximumCheckpointSchemaVersion", "features"], "candidateBinary");
  rejectUnknown(dependency, ["strategy", "cacheRoot", "cacheSha256", "packageManager"], "dependency");
  const sha256 = string(binary.sha256, "candidateBinary.sha256"), baseSha = string(input.expectedBaseSha, "expectedBaseSha");
  const sourceRunforgeSha = string(binary.sourceRunforgeSha, "candidateBinary.sourceRunforgeSha");
  if (!/^[a-f0-9]{64}$/.test(sha256) || !/^[a-f0-9]{40,64}$/.test(baseSha) || !/^[a-f0-9]{40,64}$/.test(sourceRunforgeSha)) throw new ControlPlaneError(400, "invalid_request", "Candidate binary SHA-256, source SHA, and expected base SHA must be lowercase full digests.");
  const features = binary.features === undefined ? [] : Array.isArray(binary.features) && binary.features.every((item) => typeof item === "string") ? binary.features as string[] : (() => { throw new ControlPlaneError(400, "invalid_request", "candidateBinary.features must be a string array."); })();
  const strategy = choice(dependency.strategy ?? "no_dependencies", ["verified_read_only_cache", "candidate_local_offline_install", "no_dependencies"], "dependency.strategy");
  return { artifactRoot: string(input.artifactRoot, "artifactRoot"), projectId: string(input.projectId, "projectId"), targetRepository: string(input.targetRepository, "targetRepository"), workingDirectory: string(input.workingDirectory, "workingDirectory"), expectedBaseSha: baseSha, executionAgreementId: string(input.executionAgreementId, "executionAgreementId"), authoritySnapshot: asObject(input.authoritySnapshot, "authoritySnapshot"), candidateBinary: { path: string(binary.path, "candidateBinary.path"), sha256, sourceRunforgeSha, minimumCheckpointSchemaVersion: integer(binary.minimumCheckpointSchemaVersion, "candidateBinary.minimumCheckpointSchemaVersion", 1, 100), maximumCheckpointSchemaVersion: integer(binary.maximumCheckpointSchemaVersion, "candidateBinary.maximumCheckpointSchemaVersion", 1, 100), features: [...new Set(features)].sort() }, dependency: { strategy, ...(dependency.cacheRoot === undefined ? {} : { cacheRoot: string(dependency.cacheRoot, "dependency.cacheRoot") }), ...(dependency.cacheSha256 === undefined ? {} : { cacheSha256: string(dependency.cacheSha256, "dependency.cacheSha256") }), ...(dependency.packageManager === undefined ? {} : { packageManager: choice(dependency.packageManager, ["npm", "pnpm", "yarn", "bun"] as const, "dependency.packageManager") }) } };
}
export function parseDiscardResultRequest(value: unknown): { decisionId: string; checkpointId: string; confirmation: "discard_result" } {
  const input = asObject(value, "discard result"); rejectUnknown(input, ["decisionId", "checkpointId", "confirmation"], "discard result");
  return { decisionId: optionalString(input.decisionId, "decisionId") ?? randomUUID(), checkpointId: string(input.checkpointId, "checkpointId"), confirmation: choice(input.confirmation, ["discard_result"], "confirmation") };
}
export function parseCheckpointRepairRequest(value: unknown): { taskId: string; decisionId: string; checkpointId: string; checkpointDigest: string; choice: "grant_additional_budget" | "retry_from_checkpoint"; additionalProviderTokens: number; repairIntent: string | null } {
  const input = asObject(value, "checkpoint repair");
  rejectUnknown(input, ["taskId", "decisionId", "checkpointId", "checkpointDigest", "choice", "additionalProviderTokens", "repairIntent"], "checkpoint repair");
  const choiceValue = choice(input.choice, ["grant_additional_budget", "retry_from_checkpoint"], "choice");
  const additionalProviderTokens = input.additionalProviderTokens === undefined ? 0 : integer(input.additionalProviderTokens, "additionalProviderTokens", 1, 200_000);
  const repairIntent = optionalString(input.repairIntent, "repairIntent") ?? null;
  if (choiceValue === "grant_additional_budget" && additionalProviderTokens === 0) throw new ControlPlaneError(400, "invalid_request", "grant_additional_budget requires additionalProviderTokens.");
  if (choiceValue === "retry_from_checkpoint" && !repairIntent) throw new ControlPlaneError(400, "invalid_request", "retry_from_checkpoint requires a bounded repairIntent.");
  if (repairIntent && repairIntent.length > 2_000) throw new ControlPlaneError(400, "invalid_request", "repairIntent exceeds 2000 characters.");
  const checkpointDigest = string(input.checkpointDigest, "checkpointDigest");
  if (!/^[a-f0-9]{64}$/.test(checkpointDigest)) throw new ControlPlaneError(400, "invalid_request", "checkpointDigest must be a lowercase SHA-256 digest.");
  return { taskId: string(input.taskId, "taskId"), decisionId: string(input.decisionId, "decisionId"), checkpointId: string(input.checkpointId, "checkpointId"), checkpointDigest, choice: choiceValue, additionalProviderTokens, repairIntent };
}
export class ControlPlaneError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown, public readonly retryable = false, public readonly taskId?: string) { super(message); }
}
function asObject(value: unknown, name: string, optional = false): Record<string, unknown> { if (optional && value === undefined) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError(400, "invalid_request", `${name} must be an object.`); return value as Record<string, unknown>; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const keys = Object.keys(value).filter((key) => !allowed.includes(key)); if (keys.length) throw new ControlPlaneError(400, "unknown_fields", `${name} contains unknown field(s): ${keys.join(", ")}.`); }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} must be a non-empty string.`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { return value === undefined ? undefined : string(value, name); }
function stringArray(value: unknown, name: string): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new ControlPlaneError(400, "invalid_request", `${name} must be an array of non-empty strings.`); return value.map((item, index) => string(item, `${name}[${index}]`)); }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new ControlPlaneError(400, "invalid_request", `${name} must be boolean.`); return value; }
function optionalBoolean(value: unknown, name: string): boolean | undefined { return value === undefined ? undefined : boolean(value, name); }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new ControlPlaneError(400, "invalid_request", `${name} must be one of: ${values.join(", ")}.`); return value as T; }
function optionalChoice<T extends string>(value: unknown, values: readonly T[], name: string): T | undefined { return value === undefined ? undefined : choice(value, values, name); }
function integer(value: unknown, name: string, min: number, max: number): number { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new ControlPlaneError(400, "invalid_request", `${name} must be an integer from ${min} to ${max}.`); return Number(value); }
function decimal(value: unknown, name: string, minExclusive: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= minExclusive || value > max) throw new ControlPlaneError(400, "invalid_request", `${name} must be a number > ${minExclusive} and <= ${max}.`); return value; }
