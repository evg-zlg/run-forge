import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  ]
};

const requiredRunFields = ["schemaVersion", "runId", "taskType", "status"];

export async function validatePacket(packet: string): Promise<PacketValidationResult> {
  const packetDir = resolve(packet);
  const errors: string[] = [];
  const run = await readRequiredJson(join(packetDir, "run.json"), "run.json", errors);
  const taskType = typeof run?.taskType === "string" ? run.taskType : "unknown";
  const requiredArtifacts = requiredByTaskType[taskType] ?? [];

  for (const field of requiredRunFields) requireField(run, "run.json", field, errors);
  for (const artifact of requiredArtifacts) await requireArtifact(packetDir, artifact, errors);

  const metrics = await readRequiredJson(join(packetDir, "metrics.json"), "metrics.json", errors);
  requireField(metrics, "metrics.json", "schemaVersion", errors);
  requireField(metrics, "metrics.json", "runId", errors);

  const safety = await readRequiredJson(join(packetDir, "safety-report.json"), "safety-report.json", errors);
  requireField(safety, "safety-report.json", "schemaVersion", errors);
  requireField(safety, "safety-report.json", "runId", errors);

  const manifest = await readRequiredJson(join(packetDir, "packet-manifest.json"), "packet-manifest.json", errors);
  if (!Array.isArray(manifest?.artifacts)) errors.push("packet-manifest.json missing artifacts");

  const eventsText = await readOptionalText(join(packetDir, "events.jsonl"));
  if (!eventsText.trim()) errors.push("events.jsonl has no events");

  if (taskType === "external_command_check") {
    const commandResults = await readRequiredJson(join(packetDir, "command-results.json"), "command-results.json", errors);
    if (!Array.isArray(commandResults?.commands)) errors.push("command-results.json missing commands");
  }
  if (taskType === "external_failure_triage") {
    const rootCause = await readRequiredJson(join(packetDir, "root-cause.json"), "root-cause.json", errors);
    requireField(rootCause, "root-cause.json", "category", errors);
  }
  if (taskType === "external_proposal_readiness") {
    const contract = await readRequiredJson(join(packetDir, "proposal-contract.json"), "proposal-contract.json", errors);
    requireField(contract, "proposal-contract.json", "readinessOutcome", errors);
    requireField(contract, "proposal-contract.json", "canAttemptCodeProposal", errors);
  }
  if (taskType === "external_code_proposal") {
    const status = await readRequiredJson(join(packetDir, "proposal-status.json"), "proposal-status.json", errors);
    requireField(status, "proposal-status.json", "outcome", errors);
    requireField(status, "proposal-status.json", "humanGate", errors);
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

function requireField(object: JsonObject | null, label: string, field: string, errors: string[]): void {
  if (!object || object[field] === undefined || object[field] === null || object[field] === "") {
    errors.push(`${label} missing ${field}`);
  }
}
