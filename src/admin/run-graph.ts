import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "./redaction.js";

export interface AdminGraphNode {
  id: string;
  label: string;
  status: string;
  detail: string;
  timestamp: string;
  durationMs: number | null;
}

export interface AdminRunDetail {
  packetPath: string;
  graph: AdminGraphNode[];
  graphSource: "events" | "fallback";
  summary: string;
  validationSummary: unknown | null;
  metrics: unknown | null;
  safety: unknown | null;
  artifacts: string[];
  setupPolicy: unknown | null;
  providerAudit: unknown | null;
  proposalStatus: unknown | null;
  proposalReadiness: unknown | null;
}

const FALLBACK_GRAPH = [
  "task_received",
  "route_selected",
  "setup_started",
  "setup_finished",
  "command_started",
  "command_finished",
  "triage",
  "readiness",
  "provider_patch_validator",
  "verifier",
  "reviewer",
  "packet_writer"
];

export async function buildRunDetail(packetPath: string): Promise<AdminRunDetail> {
  const [events, run, metrics, safety, manifest, setupPolicy, providerAudit, proposalStatus, validationSummary, proposalReadiness] = await Promise.all([
    readEvents(packetPath),
    readOptionalJson(join(packetPath, "run.json")),
    readOptionalJson(join(packetPath, "metrics.json")),
    readOptionalJson(join(packetPath, "safety-report.json")),
    readOptionalJson(join(packetPath, "packet-manifest.json")),
    readOptionalJson(join(packetPath, "setup-policy.json")),
    readOptionalJson(join(packetPath, "provider-safety-report.json")),
    readOptionalJson(join(packetPath, "proposal-status.json")),
    readOptionalJson(join(packetPath, "validation-summary.json")),
    readOptionalJson(join(packetPath, "proposal-readiness.json"))
  ]);

  return {
    packetPath,
    graph: events.length > 0 ? graphFromEvents(events) : graphFromFallback(run),
    graphSource: events.length > 0 ? "events" : "fallback",
    summary: summarizeRun(run, proposalStatus),
    validationSummary,
    metrics,
    safety,
    artifacts: manifestArtifacts(manifest),
    setupPolicy,
    providerAudit,
    proposalStatus,
    proposalReadiness
  };
}

function graphFromEvents(events: Array<Record<string, unknown>>): AdminGraphNode[] {
  return events.map((event, index) => {
    const type = text(event.type) || text(event.event) || text(event.name) || `event_${index + 1}`;
    const status = text(event.status) || text(event.outcome) || "observed";
    const command = text(event.command);
    const phase = text(event.phase);
    const message = text(event.message) || text(event.detail) || text(event.error);
    return {
      id: `${index + 1}-${type}`,
      label: type,
      status,
      detail: [phase, command, message].filter(Boolean).join(" | "),
      timestamp: text(event.timestamp) || text(event.time) || text(event.createdAt) || "",
      durationMs: numberOrNull(event.durationMs ?? event.duration_ms ?? event.elapsedMs)
    };
  });
}

function graphFromFallback(run: unknown): AdminGraphNode[] {
  const status = isRecord(run) && typeof run.status === "string" ? run.status : "unknown";
  return FALLBACK_GRAPH.map((label, index) => ({
    id: `${index + 1}-${label}`,
    label,
    status: index === FALLBACK_GRAPH.length - 1 ? status : "expected",
    detail: "events.jsonl not found; showing canonical operator path",
    timestamp: "",
    durationMs: null
  }));
}

async function readEvents(packetPath: string): Promise<Array<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await readFile(join(packetPath, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      events.push({ type: "unparsed_event", status: "invalid_json", raw: redactSecrets(line) });
    }
  }
  return events;
}

function summarizeRun(run: unknown, proposalStatus: unknown): string {
  const parts: string[] = [];
  if (isRecord(run)) {
    if (typeof run.taskType === "string") parts.push(`task=${run.taskType}`);
    if (typeof run.status === "string") parts.push(`status=${run.status}`);
    const repo = isRecord(run.repo) && typeof run.repo.path === "string" ? run.repo.path : "";
    if (repo) parts.push(`repo=${repo}`);
  }
  if (isRecord(proposalStatus)) {
    if (typeof proposalStatus.outcome === "string") parts.push(`outcome=${proposalStatus.outcome}`);
    if (typeof proposalStatus.providerStatus === "string") parts.push(`provider=${proposalStatus.providerStatus}`);
  }
  return parts.join(" | ") || "No packet summary artifacts found.";
}

function manifestArtifacts(manifest: unknown): string[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.artifacts)) return [];
  return manifest.artifacts.map((artifact) => {
    if (typeof artifact === "string") return artifact;
    if (isRecord(artifact) && typeof artifact.path === "string") return artifact.path;
    return "";
  }).filter(Boolean);
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
