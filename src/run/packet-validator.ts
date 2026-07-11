import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateOperatorDecisionRecord } from "./operator-decision-summary.js";
import { validatePacketManifest } from "./packet-manifest-validator.js";

export interface PacketValidationResult {
  checked: boolean;
  passed: boolean;
  packetDir: string;
  packetType: string;
  errors: string[];
}

type JsonObject = Record<string, unknown>;

const requiredByTaskType: Record<string, string[]> = {
  external_command_check: [
    "summary.md",
    "run.json",
    "events.jsonl",
    "metrics.json",
    "command-results.json",
    "safety-report.json",
    "trajectory.json",
    "packet-manifest.json"
  ],
  external_failure_triage: [
    "summary.md",
    "run.json",
    "events.jsonl",
    "metrics.json",
    "safety-report.json",
    "trajectory.json",
    "packet-manifest.json",
    "failure-triage.md",
    "root-cause.json",
    "evidence-excerpts.md",
    "safe-next-action.md"
  ],
  external_proposal_readiness: [
    "summary.md",
    "run.json",
    "events.jsonl",
    "metrics.json",
    "safety-report.json",
    "trajectory.json",
    "packet-manifest.json",
    "proposal-readiness.md",
    "proposal-contract.json",
    "missing-context.md",
    "recommended-next-action.md"
  ],
  external_code_proposal: [
    "summary.md",
    "run.json",
    "events.jsonl",
    "metrics.json",
    "safety-report.json",
    "trajectory.json",
    "packet-manifest.json",
    "human-review.md",
    "proposal.patch",
    "patch-summary.md",
    "proposal-status.json",
    "verification-results.json",
    "before-command-results.json",
    "after-command-results.json"
  ],
  task_run_external: [
    "summary.md",
    "results.json",
    "external-triage-report.md",
    "execution-log.md",
    "environment.json",
    "run.json",
    "events.jsonl",
    "metrics.json",
    "safety-report.json",
    "trajectory.json",
    "packet-manifest.json"
  ]
};

const requiredRunFields = ["schemaVersion", "runId", "taskType", "status"];
const taskTypes = new Set(Object.keys(requiredByTaskType));
const statusEnums: Record<string, Set<string>> = {
  external_command_check: new Set([
    "passed",
    "failed",
    "timed_out",
    "error",
    "blocked",
    "setup_failed",
    "setup_timed_out",
    "setup_error",
    "setup_failed_main_passed",
    "setup_failed_main_failed"
  ]),
  external_failure_triage: new Set(["triaged", "no_failure_observed", "needs_more_context"]),
  external_proposal_readiness: new Set(["ready_for_code_proposal", "needs_more_context", "research_only", "blocked_by_safety", "no_failure_observed"]),
  external_code_proposal: new Set([
    "proposal_ready_verified",
    "proposal_ready_unverified",
    "no_safe_proposal",
    "not_ready",
    "verification_failed",
    "blocked_by_safety",
    "provider_rejected",
    "provider_failed"
  ]),
  task_run_external: new Set(["passed", "deterministic failure", "environment/setup issue", "unsafe/not runnable", "needs owner approval"])
};

export async function validatePacket(packet: string): Promise<PacketValidationResult> {
  const packetDir = resolve(packet);
  const errors: string[] = [];
  const run = await readRequiredJson(join(packetDir, "run.json"), "run.json", errors);
  const taskType = typeof run?.taskType === "string" ? run.taskType : "unknown";
  const requiredArtifacts = requiredByTaskType[taskType] ?? [];

  for (const field of requiredRunFields) requireField(run, "run.json", field, errors);
  requireString(run, "run.json", "schemaVersion", errors);
  requireString(run, "run.json", "runId", errors);
  requireString(run, "run.json", "taskType", errors);
  requireString(run, "run.json", "status", errors);
  if (typeof run?.taskType === "string" && !taskTypes.has(run.taskType)) errors.push(`run.json invalid taskType ${run.taskType}`);
  if (typeof run?.status === "string" && statusEnums[taskType] && !statusEnums[taskType]!.has(run.status)) {
    errors.push(`run.json invalid status ${run.status}`);
  }
  if (run?.durationMs !== undefined) requireNumber(run, "run.json", "durationMs", errors);
  for (const artifact of requiredArtifacts) await requireArtifact(packetDir, artifact, errors);

  const metrics = await readRequiredJson(join(packetDir, "metrics.json"), "metrics.json", errors);
  requireField(metrics, "metrics.json", "schemaVersion", errors);
  requireField(metrics, "metrics.json", "runId", errors);
  requireString(metrics, "metrics.json", "schemaVersion", errors);
  requireString(metrics, "metrics.json", "runId", errors);
  if (metrics?.durationMs !== undefined) requireNumber(metrics, "metrics.json", "durationMs", errors);

  const safety = await readRequiredJson(join(packetDir, "safety-report.json"), "safety-report.json", errors);
  requireField(safety, "safety-report.json", "schemaVersion", errors);
  requireField(safety, "safety-report.json", "runId", errors);
  requireString(safety, "safety-report.json", "schemaVersion", errors);
  requireString(safety, "safety-report.json", "runId", errors);
  if (safety?.originalRepoMutationAllowed !== undefined) requireBoolean(safety, "safety-report.json", "originalRepoMutationAllowed", errors);

  const manifest = await readRequiredJson(join(packetDir, "packet-manifest.json"), "packet-manifest.json", errors);
  if (!Array.isArray(manifest?.artifacts)) errors.push("packet-manifest.json missing artifacts");
  await validatePacketManifest(packetDir, manifest, errors);

  const events = await readEvents(join(packetDir, "events.jsonl"), errors);
  if (events.length === 0) errors.push("events.jsonl has no events");
  validateEvents(events, errors);

  if (taskType === "external_command_check") {
    validateSetupPolicy(run?.setupPolicy, "run.json setupPolicy", errors);
    validateSetupPolicy(metrics?.setupPolicy, "metrics.json setupPolicy", errors);
    validateSetupPolicy(safety?.setupPolicy, "safety-report.json setupPolicy", errors);
    if (metrics?.setupNetworkIntent !== undefined && !isSetupNetworkIntent(metrics.setupNetworkIntent)) {
      errors.push("metrics.json setupNetworkIntent must be none, expected, or unknown");
    }
    if (safety?.setupNetworkIntentEnforced !== undefined) requireBoolean(safety, "safety-report.json", "setupNetworkIntentEnforced", errors);
    const commandResults = await readRequiredJson(join(packetDir, "command-results.json"), "command-results.json", errors);
    if (!Array.isArray(commandResults?.commands)) errors.push("command-results.json missing commands");
    requireString(commandResults, "command-results.json", "schemaVersion", errors);
    requireString(commandResults, "command-results.json", "runId", errors);
  }
  if (taskType === "external_failure_triage") {
    const rootCause = await readRequiredJson(join(packetDir, "root-cause.json"), "root-cause.json", errors);
    requireField(rootCause, "root-cause.json", "category", errors);
    requireString(rootCause, "root-cause.json", "category", errors);
  }
  if (taskType === "external_proposal_readiness") {
    const contract = await readRequiredJson(join(packetDir, "proposal-contract.json"), "proposal-contract.json", errors);
    requireField(contract, "proposal-contract.json", "readinessOutcome", errors);
    requireField(contract, "proposal-contract.json", "canAttemptCodeProposal", errors);
    requireString(contract, "proposal-contract.json", "schemaVersion", errors);
    requireString(contract, "proposal-contract.json", "runId", errors);
    requireString(contract, "proposal-contract.json", "readinessOutcome", errors);
    requireBoolean(contract, "proposal-contract.json", "canAttemptCodeProposal", errors);
    if (typeof contract?.readinessOutcome === "string" && !statusEnums.external_proposal_readiness.has(contract.readinessOutcome)) {
      errors.push(`proposal-contract.json invalid readinessOutcome ${contract.readinessOutcome}`);
    }
    if (contract?.allowedPaths !== undefined && !isStringArray(contract.allowedPaths)) errors.push("proposal-contract.json allowedPaths must be an array of strings");
    if (contract?.forbiddenPaths !== undefined && !isStringArray(contract.forbiddenPaths)) errors.push("proposal-contract.json forbiddenPaths must be an array of strings");
    if (contract?.maxFilesChanged !== undefined) requireNumber(contract, "proposal-contract.json", "maxFilesChanged", errors);
    if (contract?.maxPatchBytes !== undefined) requireNumber(contract, "proposal-contract.json", "maxPatchBytes", errors);
  }
  if (taskType === "external_code_proposal") {
    const status = await readRequiredJson(join(packetDir, "proposal-status.json"), "proposal-status.json", errors);
    requireField(status, "proposal-status.json", "outcome", errors);
    requireField(status, "proposal-status.json", "humanGate", errors);
    requireString(status, "proposal-status.json", "schemaVersion", errors);
    requireString(status, "proposal-status.json", "runId", errors);
    requireString(status, "proposal-status.json", "outcome", errors);
    requireString(status, "proposal-status.json", "humanGate", errors);
    if (typeof status?.outcome === "string" && !statusEnums.external_code_proposal.has(status.outcome)) {
      errors.push(`proposal-status.json invalid outcome ${status.outcome}`);
    }
    if (status?.providerEnabled === true || status?.providerStatus === "accepted" || status?.providerStatus === "rejected" || status?.providerStatus === "failed") {
      validateProviderAudit(status?.providerAudit, "proposal-status.json providerAudit", errors);
      validateProviderAudit(metrics?.providerAudit, "metrics.json providerAudit", errors);
      const providerSafety = await readRequiredJson(join(packetDir, "provider-safety-report.json"), "provider-safety-report.json", errors);
      validateProviderAudit(providerSafety?.providerAudit, "provider-safety-report.json providerAudit", errors);
    }
    if (await artifactExists(join(packetDir, "operator-decision.json"))) {
      errors.push(...await validateOperatorDecisionRecord(join(packetDir, "operator-decision.json")));
    }
  }

  if (taskType === "unknown") errors.push("run.json missing taskType");

  return {
    checked: true,
    passed: errors.length === 0,
    packetDir,
    packetType: taskType,
    errors
  };
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireArtifact(packetDir: string, artifact: string, errors: string[]): Promise<void> {
  try {
    await access(join(packetDir, artifact));
  } catch {
    errors.push(`missing ${artifact}`);
  }
}

async function readRequiredJson(path: string, label: string, errors: string[]): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch {
    errors.push(`missing or invalid ${label}`);
    return null;
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readEvents(path: string, errors: string[]): Promise<JsonObject[]> {
  const text = await readOptionalText(path);
  if (!text.trim()) return [];
  const events: JsonObject[] = [];
  for (const [index, line] of text.trim().split("\n").entries()) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        errors.push(`events.jsonl line ${index + 1} must be an object`);
      } else {
        events.push(event as JsonObject);
      }
    } catch {
      errors.push(`events.jsonl line ${index + 1} invalid JSON`);
    }
  }
  return events;
}

function requireField(object: JsonObject | null, label: string, field: string, errors: string[]): void {
  if (!object || object[field] === undefined || object[field] === null || object[field] === "") {
    errors.push(`${label} missing ${field}`);
  }
}

function requireString(object: JsonObject | null, label: string, field: string, errors: string[]): void {
  if (!object || object[field] === undefined || object[field] === null) return;
  if (typeof object[field] !== "string" || object[field] === "") errors.push(`${label} ${field} must be a non-empty string`);
}

function requireNumber(object: JsonObject | null, label: string, field: string, errors: string[]): void {
  if (!object || object[field] === undefined || object[field] === null) return;
  if (typeof object[field] !== "number" || !Number.isFinite(object[field])) errors.push(`${label} ${field} must be a finite number`);
}

function requireBoolean(object: JsonObject | null, label: string, field: string, errors: string[]): void {
  if (!object || object[field] === undefined || object[field] === null) return;
  if (typeof object[field] !== "boolean") errors.push(`${label} ${field} must be a boolean`);
}

function validateSetupPolicy(value: unknown, label: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} missing setup policy object`);
    return;
  }
  const policy = value as JsonObject;
  for (const field of ["setupCommandsProvided", "continueAfterSetupFailure", "mainCommandsSkippedOnSetupFailure"]) {
    requireField(policy, label, field, errors);
    requireBoolean(policy, label, field, errors);
  }
  requireField(policy, label, "networkIntent", errors);
  requireString(policy, label, "networkIntent", errors);
  if (policy.networkIntent !== undefined && !isSetupNetworkIntent(policy.networkIntent)) {
    errors.push(`${label} networkIntent must be none, expected, or unknown`);
  }
}

function isSetupNetworkIntent(value: unknown): boolean {
  return value === "none" || value === "expected" || value === "unknown";
}

function validateEvents(events: JsonObject[], errors: string[]): void {
  for (const [index, event] of events.entries()) {
    const label = `events.jsonl line ${index + 1}`;
    for (const field of ["schemaVersion", "eventId", "runId", "type", "time"]) requireString(event, label, field, errors);
  }
}

function validateProviderAudit(value: unknown, label: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} missing providerAudit`);
    return;
  }
  const audit = value as JsonObject;
  requireBoolean(audit, label, "enabled", errors);
  requireString(audit, label, "backend", errors);
  requireString(audit, label, "commandHash", errors);
  requireString(audit, label, "startedAt", errors);
  requireString(audit, label, "finishedAt", errors);
  for (const field of ["durationMs", "inputBytes", "outputBytes", "patchBytes"]) requireNumber(audit, label, field, errors);
  requireBoolean(audit, label, "accepted", errors);
  requireBoolean(audit, label, "rejected", errors);
  if (audit.backend !== undefined && audit.backend !== "cli") errors.push(`${label} backend must be cli`);
  if (audit.tokenUsage !== null) errors.push(`${label} tokenUsage must be null`);
  if (audit.estimatedCost !== null) errors.push(`${label} estimatedCost must be null`);
  if (audit.rejectionReason !== null && typeof audit.rejectionReason !== "string") errors.push(`${label} rejectionReason must be a string or null`);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
