import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectPacket } from "./packet-inspector.js";

interface ViewerOptions {
  packet: string;
  out: string;
}

export interface PacketViewerResult {
  packetDir: string;
  outDir: string;
  indexPath: string;
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

async function readViewerFiles(packetDir: string): Promise<Record<string, unknown>> {
  const names = [
    "run.json",
    "events.jsonl",
    "metrics.json",
    "packet-manifest.json",
    "summary.md",
    "proposal-status.json",
    "command-results.json",
    "verification-results.json",
    "safety-report.json",
    "provider-safety-report.json",
    "human-review.md",
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
  const safety = asRecord(files["provider-safety-report.json"]) ?? asRecord(files["safety-report.json"]);
  const commandResults = asRecord(files["command-results.json"]) ?? asRecord(files["verification-results.json"]);
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
      <h2>Proposal Patch</h2>
      <pre>${escapeHtml(String(files["proposal.patch"] ?? ""))}</pre>
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
