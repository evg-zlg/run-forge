import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DashboardSeedRecord, DashboardSeedResult } from "./packet-query.js";

export interface DashboardBuildOptions {
  seed: string;
  out: string;
}

export interface DashboardRecord extends DashboardSeedRecord {
  notes: string;
  safetyLabels: string[];
}

export interface DashboardData {
  schemaVersion: "alpha-12-dashboard";
  generatedAt: string;
  sourceSeedPath: string;
  summary: DashboardSummary;
  records: DashboardRecord[];
}

export interface DashboardSummary {
  total: number;
  latestAlpha: string;
  byOutcome: Record<string, number>;
  byRepo: Record<string, number>;
  byProviderStatus: Record<string, number>;
  byAlpha: Record<string, number>;
  verifiedProposals: number;
  rejectedProviderProposals: number;
  doNotApplyOrUnsafe: number;
  originalReposUnchanged: boolean;
}

export interface DashboardBuildResult {
  indexPath: string;
  dataPath: string;
  data: DashboardData;
}

export async function buildStaticDashboard(options: DashboardBuildOptions): Promise<DashboardBuildResult> {
  const seedPath = resolve(options.seed);
  const out = resolve(options.out);
  const seed = await readDashboardSeed(seedPath);
  const records = seed.records.map((record) => {
    const normalized = normalizeRecord(record);
    return {
      ...normalized,
      safetyLabels: safetyLabels(normalized)
    };
  });
  const data: DashboardData = {
    schemaVersion: "alpha-12-dashboard",
    generatedAt: new Date().toISOString(),
    sourceSeedPath: seedPath,
    summary: buildSummary(records),
    records
  };

  await mkdir(out, { recursive: true });
  const dataPath = join(out, "dashboard-data.json");
  const indexPath = join(out, "index.html");
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(indexPath, renderDashboardHtml(data), "utf8");
  return { indexPath, dataPath, data };
}

async function readDashboardSeed(path: string): Promise<DashboardSeedResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read dashboard seed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: DashboardSeedResult;
  try {
    parsed = JSON.parse(raw) as DashboardSeedResult;
  } catch (error) {
    throw new Error(`Invalid dashboard seed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed.schemaVersion !== "alpha-11-dashboard-seed" || !Array.isArray(parsed.records)) {
    throw new Error(`Invalid dashboard seed at ${path}: expected schemaVersion alpha-11-dashboard-seed with records array.`);
  }
  return parsed;
}

function normalizeRecord(record: DashboardSeedRecord): DashboardSeedRecord & { notes: string } {
  return {
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
    notes: stringField(record, "notes")
  };
}

function buildSummary(records: DashboardRecord[]): DashboardSummary {
  return {
    total: records.length,
    latestAlpha: latestAlpha(records.map((record) => record.alpha)),
    byOutcome: countBy(records, (record) => record.outcome),
    byRepo: countBy(records, (record) => record.repo),
    byProviderStatus: countBy(records, (record) => record.providerStatus),
    byAlpha: countBy(records, (record) => record.alpha),
    verifiedProposals: records.filter((record) => record.outcome === "proposal_ready_verified").length,
    rejectedProviderProposals: records.filter((record) => record.outcome === "provider_rejected" || record.providerStatus === "rejected").length,
    doNotApplyOrUnsafe: records.filter(isDoNotApplyOrUnsafe).length,
    originalReposUnchanged: records.length > 0 && records.every((record) => record.mutationVerdict === "unchanged")
  };
}

function renderDashboardHtml(data: DashboardData): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunForge Operator Dashboard</title>
  <style>${css()}</style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">RunForge Alpha-12</p>
      <h1>Static Operator Dashboard</h1>
    </div>
    <dl class="summary-grid">
      ${summaryMetric("Generated", data.generatedAt)}
      ${summaryMetric("Total records", String(data.summary.total))}
      ${summaryMetric("Latest alpha", data.summary.latestAlpha)}
      ${summaryMetric("Original repo", data.summary.originalReposUnchanged ? "unchanged" : "check evidence")}
      ${summaryMetric("Verified proposals", String(data.summary.verifiedProposals))}
      ${summaryMetric("Provider rejections", String(data.summary.rejectedProviderProposals))}
      ${summaryMetric("Do not apply / unsafe", String(data.summary.doNotApplyOrUnsafe))}
    </dl>
  </header>
  <main>
    ${renderCountSection("By outcome", data.summary.byOutcome)}
    ${renderCountSection("By repo", data.summary.byRepo)}
    ${renderCountSection("By provider status", data.summary.byProviderStatus)}
    ${renderCountSection("By alpha", data.summary.byAlpha)}
    ${renderGroup("Verified proposals", data.records.filter((record) => record.outcome === "proposal_ready_verified"))}
    ${renderGroup("Provider rejections", data.records.filter((record) => record.outcome === "provider_rejected" || record.providerStatus === "rejected"))}
    ${renderGroup("Failed / unsafe proposals", data.records.filter(isFailedOrUnsafe))}
    ${renderTable(data.records)}
  </main>
</body>
</html>
`;
}

function renderCountSection(title: string, counts: Record<string, number>): string {
  const rows = Object.entries(counts).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value}</td></tr>`).join("");
  return `<section><h2>${title}</h2><table class="counts"><tbody>${rows || "<tr><td>none</td><td>0</td></tr>"}</tbody></table></section>`;
}

function renderGroup(title: string, records: DashboardRecord[]): string {
  const items = records.map((record) => `<li><strong>${escapeHtml(record.alpha)}</strong> ${escapeHtml(record.repo)} / ${escapeHtml(record.scenario)} <span>${escapeHtml(record.outcome)}</span></li>`).join("");
  return `<section><h2>${title}</h2><ul class="record-list">${items || "<li>none</li>"}</ul></section>`;
}

function renderTable(records: DashboardRecord[]): string {
  const rows = records.map((record) => `<tr>
    <td>${escapeHtml(record.alpha)}</td>
    <td>${escapeHtml(record.repo)}</td>
    <td>${escapeHtml(record.scenario)}</td>
    <td>${escapeHtml(record.packetType)}</td>
    <td>${escapeHtml(record.outcome)}</td>
    <td>${escapeHtml(record.providerStatus)}</td>
    <td>${escapeHtml(record.operatorVerdict)}</td>
    <td>${escapeHtml(record.mutationVerdict)}</td>
    <td>${labels(record.safetyLabels)}</td>
    <td>${link(record.packetPath)}</td>
    <td>${link(record.viewerPath)}</td>
    <td>${link(record.summaryPath)}</td>
    <td>${escapeHtml(record.tags.join(", "))}</td>
    <td>${escapeHtml(record.notes ?? "")}</td>
  </tr>`).join("");
  return `<section><h2>Records</h2><table class="records"><thead><tr><th>Alpha</th><th>Repo</th><th>Scenario</th><th>Packet type</th><th>Outcome</th><th>Provider</th><th>Operator verdict</th><th>Mutation</th><th>Safety</th><th>Packet</th><th>Viewer</th><th>Summary</th><th>Tags</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function safetyLabels(record: DashboardSeedRecord): string[] {
  const labels = new Set<string>();
  if (record.mutationVerdict === "unchanged") labels.add("original repo unchanged");
  if (record.operatorVerdict === "do_not_apply" || record.operatorVerdict === "no_apply") labels.add("do_not_apply");
  if (record.providerStatus === "rejected" || record.outcome === "provider_rejected") labels.add("provider rejected");
  if (record.outcome.includes("failed") || record.providerStatus.includes("failed")) labels.add("verification failed");
  if (record.outcome === "proposal_ready_verified") labels.add("proposal_ready_verified");
  if (isDoNotApplyOrUnsafe(record)) labels.add("unsafe/do_not_apply");
  return [...labels].sort();
}

function labels(values: string[]): string {
  return values.map((value) => `<span class="label">${escapeHtml(value)}</span>`).join(" ");
}

function link(path: string): string {
  if (!path || path === "unknown") return "unknown";
  const href = path.startsWith("/") ? `file://${path}` : path;
  return `<a href="${escapeHtml(href)}">${escapeHtml(basename(path) || path)}</a>`;
}

function summaryMetric(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function isFailedOrUnsafe(record: DashboardSeedRecord): boolean {
  const text = `${record.outcome} ${record.providerStatus} ${record.operatorVerdict} ${record.mutationVerdict} ${record.tags.join(" ")}`.toLowerCase();
  return text.includes("rejected") || text.includes("failed") || text.includes("unsafe") || text.includes("forbidden") || text.includes("do_not_apply");
}

function isDoNotApplyOrUnsafe(record: DashboardSeedRecord): boolean {
  const text = `${record.outcome} ${record.operatorVerdict} ${record.tags.join(" ")}`.toLowerCase();
  return text.includes("do_not_apply") || text.includes("unsafe") || text.includes("forbidden");
}

function latestAlpha(alphas: string[]): string {
  return [...new Set(alphas)].sort((a, b) => alphaNumber(a) - alphaNumber(b) || a.localeCompare(b)).at(-1) ?? "unknown";
}

function alphaNumber(alpha: string): number {
  const match = /^ALPHA-(\d+)/.exec(alpha);
  return match ? Number(match[1]) : -1;
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyFor(item) || "unknown"] = (counts[keyFor(item) || "unknown"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function stringField(record: DashboardSeedRecord, key: string): string {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function css(): string {
  return `body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9;color:#18202a}header{background:#17212f;color:#fff;padding:28px 32px}main{padding:24px 32px}h1{margin:0;font-size:28px}h2{font-size:18px;margin:0 0 12px}.eyebrow{margin:0 0 6px;color:#a7c7ff;text-transform:uppercase;font-size:12px}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0 0}.summary-grid div,section{background:#fff;color:#18202a;border:1px solid #d9dee7;border-radius:6px}.summary-grid div{padding:12px}.summary-grid dt{font-size:12px;color:#5c6675}.summary-grid dd{margin:4px 0 0;font-weight:700}section{padding:16px;margin:0 0 16px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e4e8ef;text-align:left;padding:8px;vertical-align:top}th{background:#eef2f7}.counts{max-width:620px}.record-list{margin:0;padding-left:18px}.record-list li{margin:6px 0}.record-list span,.label{display:inline-block;background:#eef2f7;border:1px solid #d1d8e3;border-radius:4px;padding:2px 6px;margin:1px;color:#273142}a{color:#0759b8}`;
}
