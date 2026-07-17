import { randomUUID } from "node:crypto";

export const controlPlaneApiVersion = "v1";
export const defaultControlPlaneHost = "127.0.0.1";
export const defaultControlPlanePort = 7373;
export const defaultMaxRequestBytes = 1_048_576;

export type ControlAuthority = {
  inspect: boolean;
  implementation: boolean;
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
  kind: "owner" | "publication";
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
  authority: ControlAuthority;
  publicationRequested: "none" | "draft-pr";
  publicationGate: { required: boolean; status: string; reason?: string };
  ownerGate: { required: boolean; status: string; reason?: string };
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
};

export function defaultAuthority(value: unknown): ControlAuthority {
  const input = asObject(value, "authority", true);
  const allowed = ["inspect", "implementation", "localBranch", "localCommit", "remotePush", "draftPublication", "merge", "deploy"];
  rejectUnknown(input, allowed, "authority");
  const flag = (name: string, fallback: boolean) => input[name] === undefined ? fallback : boolean(input[name], `authority.${name}`);
  const authority = {
    inspect: flag("inspect", true), implementation: flag("implementation", false), localBranch: flag("localBranch", false),
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

export function parseTaskRequest(value: unknown): { projectId?: string; taskSpec: Record<string, unknown>; authority: ControlAuthority; publicationRequested: "none" | "draft-pr" } {
  const input = asObject(value, "task request");
  rejectUnknown(input, ["projectId", "taskSpec", "authority", "publication"], "task request");
  const taskSpec = asObject(input.taskSpec, "taskSpec");
  const publication = input.publication === undefined ? "none" : choice(input.publication, ["none", "draft-pr"], "publication");
  return { ...(input.projectId === undefined ? {} : { projectId: string(input.projectId, "projectId") }), taskSpec, authority: defaultAuthority(input.authority), publicationRequested: publication };
}

export function parseDecisionRequest(value: unknown, kind: "owner" | "publication"): { decisionId: string; decision: string; targetBranch?: string; note: string } {
  const input = asObject(value, `${kind} decision`);
  rejectUnknown(input, ["decisionId", "decision", "targetBranch", "note"], `${kind} decision`);
  const decision = choice(input.decision, kind === "owner" ? ["approve", "reject", "continue", "hold"] : ["approve", "reject", "hold"], "decision");
  return { decisionId: optionalString(input.decisionId, "decisionId") ?? randomUUID(), decision, ...(input.targetBranch === undefined ? {} : { targetBranch: string(input.targetBranch, "targetBranch") }), note: string(input.note, "note") };
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
