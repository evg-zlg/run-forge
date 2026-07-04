import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validatePacket, type PacketValidationResult } from "./packet-validator.js";

export type PacketInspectFormat = "text" | "json" | "mermaid";

export interface PacketInspectOptions {
  packet: string;
  format?: PacketInspectFormat;
  validate?: boolean;
}

interface RunJson {
  runId?: string;
  taskType?: string;
  status?: string;
}

interface ProposalStatus {
  outcome?: string;
  strategy?: string | null;
}

interface ManifestJson {
  artifacts?: Array<{ path?: string; type?: string; sizeBytes?: number }>;
}

interface EventJson {
  type?: string;
  workerRole?: string;
}

export interface PacketInspection {
  packetDir: string;
  runId: string;
  packetType: string;
  status: string;
  strategy: string | null;
  route: string[];
  artifacts: Array<{ path: string; type?: string; sizeBytes?: number }>;
  validation?: PacketValidationResult;
}

export async function inspectPacket(options: PacketInspectOptions): Promise<PacketInspection> {
  const packetDir = resolve(options.packet);
  const run = await readJson<RunJson>(join(packetDir, "run.json"));
  const proposalStatus = await readOptionalJson<ProposalStatus>(join(packetDir, "proposal-status.json"));
  const manifest = await readOptionalJson<ManifestJson>(join(packetDir, "packet-manifest.json"));
  const events = await readEvents(join(packetDir, "events.jsonl"));
  const route = routeFromEvents(events);

  const inspection: PacketInspection = {
    packetDir,
    runId: run.runId ?? "unknown",
    packetType: normalizePacketType(run.taskType),
    status: proposalStatus?.outcome ?? run.status ?? "unknown",
    strategy: proposalStatus?.strategy ?? null,
    route,
    artifacts: (manifest?.artifacts ?? []).flatMap((artifact) => artifact.path ? [{
      path: artifact.path,
      type: artifact.type,
      sizeBytes: artifact.sizeBytes
    }] : [])
  };
  if (options.validate) inspection.validation = await validatePacket(packetDir);
  return inspection;
}

export function renderPacketInspection(inspection: PacketInspection, format: PacketInspectFormat = "text"): string {
  if (format === "json") return `${JSON.stringify(inspection, null, 2)}\n`;
  if (format === "mermaid") return renderMermaid(inspection);
  return renderText(inspection);
}

function renderText(inspection: PacketInspection): string {
  return [
    `Run ID: ${inspection.runId}`,
    `Packet type: ${inspection.packetType}`,
    `Status: ${inspection.status}`,
    `Strategy: ${inspection.strategy ?? "none"}`,
    ...(inspection.validation ? [
      "",
      `Validation: ${inspection.validation.passed ? "passed" : "failed"}`,
      ...inspection.validation.errors.map((error) => `- ${error}`)
    ] : []),
    "",
    "Route:",
    inspection.route.length > 0 ? inspection.route.join("\n-> ") : "(no events route found)",
    "",
    "Artifacts:",
    ...(inspection.artifacts.length > 0 ? inspection.artifacts.map((artifact) => `- ${artifact.path}`) : ["- (no manifest artifacts found)"])
  ].join("\n");
}

function renderMermaid(inspection: PacketInspection): string {
  const route = inspection.route.length > 0 ? inspection.route : ["packet"];
  const lines = ["flowchart TD"];
  for (let index = 0; index < route.length; index += 1) {
    lines.push(`  n${index}["${escapeMermaidLabel(route[index]!)}"]`);
    if (index > 0) lines.push(`  n${index - 1} --> n${index}`);
  }
  return `${lines.join("\n")}\n`;
}

function routeFromEvents(events: EventJson[]): string[] {
  const route: string[] = [];
  for (const event of events) {
    if (event.type === "task_received") route.push("task_received");
    else if (event.type === "worker_finished" && event.workerRole) route.push(event.workerRole);
    else if (event.type === "run_finished") route.push("run_finished");
  }
  return route;
}

function normalizePacketType(taskType?: string): string {
  if (!taskType) return "unknown";
  return taskType.replace(/^external_/, "");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

async function readEvents(path: string): Promise<EventJson[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventJson);
  } catch {
    return [];
  }
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, '\\"');
}
