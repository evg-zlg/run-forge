import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectPacket } from "./packet-inspector.js";
import type { PacketIndexResult } from "./packet-indexer.js";
import { renderOperatorDecision } from "./packet-viewer-operator.js";

interface ViewerOptions {
  packet: string;
  out: string;
}

export interface PacketViewerResult {
  packetDir: string;
  outDir: string;
  indexPath: string;
}

export interface PacketViewerIndexOptions {
  index: string;
  out: string;
  strict?: boolean;
}

export interface PacketViewerIndexRecord {
  milestone: string;
  scenario: string;
  packetPath: string;
  viewerPath: string | null;
  status: "rendered" | "skipped" | "failed";
  reason?: string;
}

export interface PacketViewerIndexResult {
  indexPath: string;
  outDir: string;
  totalRecords: number;
  rendered: number;
  skipped: number;
  failed: number;
  records: PacketViewerIndexRecord[];
  summaryPath: string;
  jsonPath: string;
}

export async function exportPacketViewer(options: ViewerOptions): Promise<PacketViewerResult> {
  const packetDir = resolve(options.packet);
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const inspection = await inspectPacket({ packet: packetDir, validate: true });
  const files = await readViewerFiles(packetDir);
  const html = renderViewerHtml({ packetDir, inspection, files });
  const indexPath = join(outDir, "index.html");
  await writeFile(indexPath, html, "utf8");
  return { packetDir, outDir, indexPath };
}

export async function exportPacketViewersForIndex(options: PacketViewerIndexOptions): Promise<PacketViewerIndexResult> {
  const indexPath = resolve(options.index);
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const index = JSON.parse(await readFile(indexPath, "utf8")) as PacketIndexResult;
  const records: PacketViewerIndexRecord[] = [];

  for (const [entryIndex, entry] of index.entries.entries()) {
    const packetPath = entry.packetPath;
    if (!packetPath || packetPath === "unknown") {
      records.push({
        milestone: entry.milestone,
        scenario: entry.scenario,
        packetPath: packetPath || "unknown",
        viewerPath: null,
        status: "skipped",
        reason: "index record has no packetPath"
      });
      continue;
    }

    try {
      await access(packetPath);
      const viewerOut = join(outDir, viewerDirName(entryIndex, entry.milestone, entry.scenario, packetPath));
      const rendered = await exportPacketViewer({ packet: packetPath, out: viewerOut });
      records.push({
        milestone: entry.milestone,
        scenario: entry.scenario,
        packetPath,
        viewerPath: rendered.indexPath,
        status: "rendered"
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      records.push({
        milestone: entry.milestone,
        scenario: entry.scenario,
        packetPath,
        viewerPath: null,
        status: options.strict ? "failed" : "skipped",
        reason
      });
      if (options.strict) break;
    }
  }

  const result: PacketViewerIndexResult = {
    indexPath,
    outDir,
    totalRecords: index.entries.length,
    rendered: records.filter((record) => record.status === "rendered").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    failed: records.filter((record) => record.status === "failed").length,
    records,
    summaryPath: join(outDir, "viewer-index-summary.md"),
    jsonPath: join(outDir, "viewer-index-summary.json")
  };
  await writeFile(result.jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(result.summaryPath, renderViewerIndexSummary(result), "utf8");
  if (options.strict && result.failed > 0) throw new Error(`Failed to render ${result.failed} indexed packet viewer(s). See ${result.summaryPath}`);
  return result;
}

export function renderViewerIndexSummary(result: PacketViewerIndexResult): string {
  const lines = [
    "# RunForge Indexed Packet Viewers",
    "",
    `Index: ${result.indexPath}`,
    `Output: ${result.outDir}`,
    `Total records: ${result.totalRecords}`,
    `Rendered: ${result.rendered}`,
    `Skipped: ${result.skipped}`,
    `Failed: ${result.failed}`,
    "",
    "| Status | Milestone | Scenario | Packet | Viewer | Reason |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const record of result.records) {
    lines.push([
      record.status,
      record.milestone,
      record.scenario,
      record.packetPath,
      record.viewerPath ?? "",
      record.reason ?? ""
    ].map(markdownCell).join(" | "));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function readViewerFiles(packetDir: string): Promise<Record<string, unknown>> {
  const names = [
    "run.json",
    "events.jsonl",
    "metrics.json",
    "packet-manifest.json",
    "summary.md",
    "proposal-status.json",
    "setup-results.json",
    "command-results.json",
    "verification-results.json",
    "safety-report.json",
    "provider-safety-report.json",
    "human-review.md",
    "operator-decision.json",
    "operator-summary.md",
    "proposal.patch"
  ];
  const files: Record<string, unknown> = {};
  for (const name of names) {
    const path = join(packetDir, name);
    try {
      const text = await readFile(path, "utf8");
      files[name] = name.endsWith(".json") ? JSON.parse(text) : text;
    } catch {
      files[name] = null;
    }
  }
  return files;
}

function renderViewerHtml(input: { packetDir: string; inspection: Awaited<ReturnType<typeof inspectPacket>>; files: Record<string, unknown> }): string {
  const { inspection, files } = input;
  const metrics = asRecord(files["metrics.json"]);
  const manifest = asRecord(files["packet-manifest.json"]);
  const proposalStatus = asRecord(files["proposal-status.json"]);
  const run = asRecord(files["run.json"]);
  const setupPolicy = asRecord(run?.setupPolicy);
  const safety = asRecord(files["provider-safety-report.json"]) ?? asRecord(files["safety-report.json"]);
  const setupResults = asRecord(files["setup-results.json"]);
  const commandResults = asRecord(files["command-results.json"]) ?? asRecord(files["verification-results.json"]);
  const operatorDecision = asRecord(files["operator-decision.json"]);
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts as Array<Record<string, unknown>> : inspection.artifacts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunForge Packet ${escapeHtml(inspection.runId)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #20201d; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 1px solid #d8d6ce; padding-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
    section { padding: 22px 0; border-bottom: 1px solid #dedbd2; }
    .meta { color: #646158; font-size: 13px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px; border: 1px solid #969185; border-radius: 6px; background: #fff; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .item { border: 1px solid #d8d6ce; border-radius: 8px; background: #fff; padding: 12px; min-width: 0; }
    .label { color: #6d685f; font-size: 12px; margin-bottom: 5px; }
    .value { font-size: 14px; overflow-wrap: anywhere; }
    .graph { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .node { border: 1px solid #8e9a93; background: #eef3ef; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .arrow { color: #777269; }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 5px 0; overflow-wrap: anywhere; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #fff; border: 1px solid #d8d6ce; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.45; max-height: 360px; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>RunForge Packet</h1>
        <div class="meta">${escapeHtml(input.packetDir)}</div>
      </div>
      <div class="status">${escapeHtml(inspection.status)}</div>
    </header>

    <section>
      <h2>Summary</h2>
      <div class="grid">
        ${fact("Run ID", inspection.runId)}
        ${fact("Packet type", inspection.packetType)}
        ${fact("Strategy", inspection.strategy ?? "none")}
        ${fact("Validation", inspection.validation?.passed ? "passed" : "failed")}
        ${fact("Reviewer", String(proposalStatus?.reviewerDecision ?? "n/a"))}
        ${fact("Outcome", String(proposalStatus?.outcome ?? inspection.status))}
        ${fact("Setup network", String(setupPolicy?.networkIntent ?? "n/a"))}
        ${fact("Setup mode", setupMode(setupPolicy))}
      </div>
    </section>

    <section>
      <h2>Validation Errors</h2>
      ${renderValidationErrors(inspection.validation?.errors ?? [])}
    </section>

    <section>
      <h2>Worker Graph</h2>
      <div class="graph">${renderGraph(inspection.route)}</div>
    </section>

    <section>
      <h2>Command Results</h2>
      <h3>Setup</h3>
      ${renderCommands(setupResults)}
      <h3>Main</h3>
      ${renderCommands(commandResults)}
    </section>

    <section>
      <h2>Artifacts</h2>
      <ul>${artifacts.map((artifact) => `<li>${escapeHtml(String(artifact.path ?? ""))} <span class="meta">${escapeHtml(String(artifact.type ?? ""))}</span></li>`).join("") || "<li>none</li>"}</ul>
    </section>

    <section>
      <h2>Metrics</h2>
      <pre>${escapeHtml(JSON.stringify(metrics ?? {}, null, 2))}</pre>
    </section>

    <section>
      <h2>Safety</h2>
      <pre>${escapeHtml(JSON.stringify(safety ?? {}, null, 2))}</pre>
    </section>

    <section>
      <h2>Operator Decision</h2>
      ${renderOperatorDecision(operatorDecision)}
    </section>

    <section>
      <h2>Proposal Patch</h2>
      <pre>${escapeHtml(String(files["proposal.patch"] ?? ""))}</pre>
    </section>

    <section>
      <h2>Operator Summary</h2>
      <pre>${escapeHtml(String(files["operator-summary.md"] ?? ""))}</pre>
    </section>

    <section>
      <h2>Summary Markdown</h2>
      <pre>${escapeHtml(String(files["summary.md"] ?? ""))}</pre>
    </section>
  </main>
</body>
</html>
`;
}

function renderValidationErrors(errors: string[]): string {
  if (errors.length === 0) return '<div class="meta">No validation errors.</div>';
  return `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
}

function renderGraph(route: string[]): string {
  const nodes = route.length > 0 ? route : ["packet"];
  return nodes.map((node, index) => `${index > 0 ? '<span class="arrow">&rarr;</span>' : ""}<span class="node">${escapeHtml(node)}</span>`).join("");
}

function renderCommands(commandResults: Record<string, unknown> | null): string {
  const commands = Array.isArray(commandResults?.commands) ? commandResults.commands as Array<Record<string, unknown>> : [];
  if (commands.length === 0) return "<div class=\"meta\">No command result artifact found.</div>";
  return `<ul>${commands.map((command) => `<li>${escapeHtml(String(command.command ?? ""))} - ${escapeHtml(String(command.status ?? "unknown"))} (exit ${escapeHtml(String(command.exitCode ?? "null"))})</li>`).join("")}</ul>`;
}

function fact(label: string, value: string): string {
  return `<div class="item"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function setupMode(policy: Record<string, unknown> | null): string {
  if (!policy) return "n/a";
  return policy.continueAfterSetupFailure === true ? "diagnostic continue" : "gate main commands";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function viewerDirName(index: number, milestone: string, scenario: string, packetPath: string): string {
  return `${String(index + 1).padStart(3, "0")}-${slug(milestone)}-${slug(scenario)}-${slug(basename(packetPath)) || "packet"}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function markdownCell(value: string): string {
  return ` ${value.replaceAll("|", "\\|")} `;
}
