import { randomUUID } from "node:crypto";
import type { ExecutionAgreement, ExecutionAgreementConflict, ExecutionParty, ExecutionPhaseId, ExecutionProfile } from "../product/execution-agreement.js";

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
  checkpointRepair?: { schemaVersion: 1; decisionId: string; checkpointId: string; checkpointDigest: string; checkpointArtifactRoot: string; baseSha: string; executionAgreementId: string; choice: "grant_additional_budget" | "retry_from_checkpoint"; additionalProviderTokens: number; repairIntent: string | null; sourceExecutionId: string; repairExecutionId: string | null };
  selection?: {
    requestedMode: string; normalizedMode: string; selectedExecutor: string | null; selectedRuntime: string | null;
    selectionReason: string; rejectedAlternatives: Array<{ id: string; reason: string }>;
    authorityChecks: Record<string, boolean>; providerDecision: string; networkDecision: string;
    provider: string | null; model: string | null;
  };
};

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

function asObject(value: unknown, name: string, optional = false): Record<string, unknown> {
  if (optional && value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError(400, "invalid_request", `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const keys = Object.keys(value).filter((key) => !allowed.includes(key)); if (keys.length) throw new ControlPlaneError(400, "unknown_fields", `${name} contains unknown field(s): ${keys.join(", ")}.`); }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} must be a non-empty string.`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { return value === undefined ? undefined : string(value, name); }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new ControlPlaneError(400, "invalid_request", `${name} must be boolean.`); return value; }
function optionalBoolean(value: unknown, name: string): boolean | undefined { return value === undefined ? undefined : boolean(value, name); }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new ControlPlaneError(400, "invalid_request", `${name} must be one of: ${values.join(", ")}.`); return value as T; }
function optionalChoice<T extends string>(value: unknown, values: readonly T[], name: string): T | undefined { return value === undefined ? undefined : choice(value, values, name); }
function integer(value: unknown, name: string, min: number, max: number): number { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new ControlPlaneError(400, "invalid_request", `${name} must be an integer from ${min} to ${max}.`); return Number(value); }
