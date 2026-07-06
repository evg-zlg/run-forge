import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DashboardSeedRecord, DashboardSeedResult } from "./packet-query.js";
import { dashboardCss, dashboardJs } from "./dashboard-assets.js";
import { isDoNotApplyOrUnsafe, isFailedOrUnsafe, safetyLabels, searchableRecordText, stringField } from "./dashboard-record-utils.js";
import { buildSummary, type AlphaComparisonSummary, type DashboardSummary } from "./dashboard-summary.js";

export interface DashboardBuildOptions {
  seed: string;
  out: string;
}

export interface DashboardRecord extends DashboardSeedRecord {
  notes: string;
  safetyLabels: string[];
  validationEvidencePath: string;
  providerAuditPath: string;
  proposalPatchPath: string;
  humanReviewPath: string;
}

export interface DashboardData {
  schemaVersion: "alpha-12-dashboard";
  generatedAt: string;
  sourceSeedPath: string;
  summary: DashboardSummary;
  records: DashboardRecord[];
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

type NormalizedDashboardSeedRecord = DashboardSeedRecord & {
  notes: string;
  validationEvidencePath: string;
  providerAuditPath: string;
  proposalPatchPath: string;
  humanReviewPath: string;
};

function normalizeRecord(record: DashboardSeedRecord): NormalizedDashboardSeedRecord {
  return {
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
    notes: stringField(record, "notes"),
    validationEvidencePath: stringField(record, "validationEvidencePath"),
    providerAuditPath: stringField(record, "providerAuditPath"),
    proposalPatchPath: stringField(record, "proposalPatchPath"),
    humanReviewPath: stringField(record, "humanReviewPath")
  };
}

function renderDashboardHtml(data: DashboardData): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunForge Operator Dashboard</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">RunForge Alpha-12</p>
      <h1>Static Operator Dashboard</h1>
      <p class="lede">Local-only dashboard. File links use browser-dependent <code>file://</code> URLs; every artifact path is also rendered as copyable text.</p>
    </div>
    <dl class="summary-grid">
      ${summaryMetric("Generated", data.generatedAt)}
      ${summaryMetric("Total records", String(data.summary.total))}
      ${summaryMetric("Latest alpha", data.summary.latestAlpha)}
      ${summaryMetric("Original repo", data.summary.originalReposUnchanged ? "unchanged" : "check evidence")}
      ${summaryMetric("Verified proposals", String(data.summary.verifiedProposals))}
      ${summaryMetric("Provider rejections", String(data.summary.rejectedProviderProposals))}
      ${summaryMetric("Do not apply / unsafe", String(data.summary.doNotApplyOrUnsafe))}
      ${summaryMetric("Repos covered", String(data.summary.reposCovered))}
      ${summaryMetric("Unchanged mutations", String(data.summary.unchangedMutationVerdicts))}
      ${summaryMetric("Latest verified", data.summary.latestVerifiedProposal)}
      ${summaryMetric("Latest rejection", data.summary.latestRejection)}
    </dl>
  </header>
  <main>
    ${renderFilters(data.records)}
    <div class="summary-sections">
      ${renderCountSection("By repo", data.summary.byRepo, "repo")}
      ${renderCountSection("By scenario", data.summary.byScenario, "scenario")}
      ${renderCountSection("By outcome", data.summary.byOutcome, "outcome")}
      ${renderCountSection("By alpha / milestone", data.summary.byAlpha, "alpha")}
    </div>
    ${renderAlphaComparison(data.summary.byAlphaComparison)}
    ${renderCountSection("By provider status", data.summary.byProviderStatus)}
    ${renderGroup("Verified proposals", data.records.filter((record) => record.outcome === "proposal_ready_verified"))}
    ${renderGroup("Provider rejections", data.records.filter((record) => record.outcome === "provider_rejected" || record.providerStatus === "rejected"))}
    ${renderGroup("Failed / unsafe proposals", data.records.filter(isFailedOrUnsafe))}
    ${renderTable(data.records)}
  </main>
  <script>${dashboardJs()}</script>
</body>
</html>
`;
}

function renderFilters(records: DashboardRecord[]): string {
  return `<section class="filters" aria-labelledby="filters-title">
    <div class="section-title">
      <h2 id="filters-title">Search and filters</h2>
      <button id="reset-filters" type="button">Reset filters</button>
    </div>
    <div class="filter-grid">
      <label>Search
        <input id="dashboard-search" type="search" placeholder="repo, scenario, outcome, provider, notes, tags" autocomplete="off">
      </label>
      ${selectFilter("outcome-filter", "Outcome", unique(records.map((record) => record.outcome)))}
      ${selectFilter("repo-filter", "Repo", unique(records.map((record) => record.repo)))}
      ${selectFilter("provider-status-filter", "Provider status", unique(records.map((record) => record.providerStatus)))}
      ${selectFilter("mutation-verdict-filter", "Mutation verdict", unique(records.map((record) => record.mutationVerdict)))}
      ${selectFilter("alpha-filter", "Alpha / milestone", unique(records.map((record) => record.alpha)))}
    </div>
    <div class="quick-actions" aria-label="Quick filters">
      <button id="quick-verified" type="button" data-quick-filter="verified">Show only verified proposals</button>
      <button id="quick-unsafe" type="button" data-quick-filter="unsafe">Show only unsafe/do_not_apply</button>
      <button id="copy-current-view" type="button">Copy current view</button>
      <label>Current view URL
        <input id="current-view-url" type="text" readonly value="">
      </label>
    </div>
    <div class="filter-status" aria-live="polite">
      <span>Total records: <strong id="total-records">${records.length}</strong></span>
      <span>Visible records: <strong id="visible-records">${records.length}</strong></span>
      <span>Active filters: <strong id="active-filters">none</strong></span>
      <span id="copy-current-view-status" class="muted"></span>
    </div>
  </section>`;
}

function selectFilter(id: string, label: string, values: string[]): string {
  const options = values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("");
  return `<label>${escapeHtml(label)}
    <select id="${escapeAttr(id)}">
      <option value="">All</option>
      ${options}
    </select>
  </label>`;
}

function renderCountSection(title: string, counts: Record<string, number>, filterKey = ""): string {
  const rows = Object.entries(counts).map(([key, value]) => {
    const label = filterKey ? `<button type="button" class="link-button" data-filter-key="${escapeAttr(filterKey)}" data-filter-value="${escapeAttr(key)}">${escapeHtml(key)}</button>` : escapeHtml(key);
    return `<tr><td>${label}</td><td>${value}</td></tr>`;
  }).join("");
  return `<section><h2>${title}</h2><table class="counts"><tbody>${rows || "<tr><td>none</td><td>0</td></tr>"}</tbody></table></section>`;
}

function renderAlphaComparison(rows: AlphaComparisonSummary[]): string {
  const body = rows.map((row) => `<tr>
    <td><button type="button" class="link-button" data-filter-key="alpha" data-filter-value="${escapeAttr(row.alpha)}">${escapeHtml(row.alpha)}</button></td>
    <td>${row.total}</td>
    <td>${row.verifiedProposals}</td>
    <td>${row.rejectedProviderProposals}</td>
    <td>${row.doNotApplyOrUnsafe}</td>
    <td>${row.unchangedMutationVerdicts}</td>
    <td>${row.reposCovered}</td>
  </tr>`).join("");
  return `<section>
    <h2>Alpha comparison</h2>
    <table class="counts alpha-comparison">
      <thead><tr><th>Alpha</th><th>Records</th><th>Verified</th><th>Rejected</th><th>Unsafe</th><th>Unchanged</th><th>Repos</th></tr></thead>
      <tbody>${body || "<tr><td>none</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>"}</tbody>
    </table>
  </section>`;
}

function renderGroup(title: string, records: DashboardRecord[]): string {
  const items = records.map((record) => `<li><strong>${escapeHtml(record.alpha)}</strong> ${escapeHtml(record.repo)} / ${escapeHtml(record.scenario)} <span>${escapeHtml(record.outcome)}</span></li>`).join("");
  return `<section><h2>${title}</h2><ul class="record-list">${items || "<li>none</li>"}</ul></section>`;
}

function renderTable(records: DashboardRecord[]): string {
  const rows = records.map((record) => `<tr class="record-row ${rowClass(record)}" data-search="${escapeAttr(searchText(record))}" data-outcome="${escapeAttr(record.outcome)}" data-repo="${escapeAttr(record.repo)}" data-scenario="${escapeAttr(record.scenario)}" data-provider-status="${escapeAttr(record.providerStatus)}" data-mutation-verdict="${escapeAttr(record.mutationVerdict)}" data-alpha="${escapeAttr(record.alpha)}" data-unsafe="${isDoNotApplyOrUnsafe(record) ? "true" : "false"}">
    <td>${escapeHtml(record.alpha)}</td>
    <td>${escapeHtml(record.repo)}</td>
    <td>${escapeHtml(record.scenario)}</td>
    <td>${escapeHtml(record.packetType)}</td>
    <td>${outcomeBadge(record.outcome)}</td>
    <td>${providerStatus(record)}</td>
    <td>${operatorVerdict(record)}</td>
    <td>${mutationVerdict(record)}</td>
    <td>${labels(record.safetyLabels)}</td>
    <td>${artifactLink("Packet path", record.packetPath)}</td>
    <td>${artifactLink("Viewer path", record.viewerPath)}</td>
    <td>${artifactLink("Summary path", record.summaryPath)}</td>
    <td>${renderDetails(record)}</td>
    <td>${escapeHtml(record.tags.join(", "))}</td>
    <td>${escapeHtml(record.notes ?? "")}</td>
  </tr>`).join("");
  return `<section><h2>Records</h2><table class="records" id="records-table"><thead><tr><th><button type="button" class="sort-button" data-sort="alpha">Alpha</button></th><th><button type="button" class="sort-button" data-sort="repo">Repo</button></th><th><button type="button" class="sort-button" data-sort="scenario">Scenario</button></th><th>Packet type</th><th><button type="button" class="sort-button" data-sort="outcome">Outcome</button></th><th><button type="button" class="sort-button" data-sort="providerStatus">Provider</button></th><th>Operator verdict</th><th><button type="button" class="sort-button" data-sort="mutationVerdict">Mutation</button></th><th>Safety</th><th>Packet</th><th>Viewer</th><th>Summary</th><th>Details</th><th>Tags</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table><p id="empty-state" class="empty-state" hidden>No records match the active filters. Reset filters or copy the current view URL to share this empty state.</p></section>`;
}

function labels(values: string[]): string {
  return values.map((value) => `<span class="label label-${labelClass(value)}">${escapeHtml(value)}</span>`).join(" ");
}

function artifactLink(label: string, path: string): string {
  if (!path || path === "unknown") return "unknown";
  const href = path.startsWith("/") ? `file://${path}` : path;
  return `<div class="artifact"><a href="${escapeAttr(href)}">${escapeHtml(basename(path) || path)}</a><code aria-label="${escapeAttr(label)}">${escapeHtml(path)}</code></div>`;
}

function summaryMetric(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderDetails(record: DashboardRecord): string {
  return `<details>
    <summary>Evidence drilldown</summary>
    <div class="details-body">
      <p><strong>Operator verdict:</strong> ${escapeHtml(operatorVerdictText(record.operatorVerdict))}</p>
      <p><strong>Provider status:</strong> ${escapeHtml(record.providerStatus)}</p>
      <p><strong>Reason:</strong> ${escapeHtml(reasonFor(record))}</p>
      <div class="artifact-list">
        ${artifactRow("Packet path", record.packetPath)}
        ${artifactRow("Viewer path", record.viewerPath)}
        ${artifactRow("Summary path", record.summaryPath)}
        ${artifactRow("Validation evidence path", record.validationEvidencePath)}
        ${artifactRow("Provider audit path", record.providerAuditPath)}
        ${artifactRow("Proposal patch path", record.proposalPatchPath)}
        ${artifactRow("Human review path", record.humanReviewPath)}
      </div>
      <p><strong>Safety notes:</strong> ${escapeHtml(record.safetyLabels.join(", ") || "none")}</p>
      <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
    </div>
  </details>`;
}

function artifactRow(label: string, path: string): string {
  return `<div><strong>${escapeHtml(label)}:</strong> ${artifactLink(label, path || "unknown")}</div>`;
}

function outcomeBadge(outcome: string): string {
  return `<span class="outcome outcome-${labelClass(outcome)}">${escapeHtml(outcome)}</span>`;
}

function providerStatus(record: DashboardRecord): string {
  return `<span class="${record.providerStatus === "rejected" ? "danger-text" : ""}">${escapeHtml(record.providerStatus)}</span>`;
}

function operatorVerdict(record: DashboardRecord): string {
  return `<span class="${isDoNotApplyVerdict(record.operatorVerdict) ? "danger-text" : ""}">${escapeHtml(operatorVerdictText(record.operatorVerdict))}</span>`;
}

function mutationVerdict(record: DashboardRecord): string {
  return record.mutationVerdict === "unchanged" ? `<span class="safe-text">unchanged</span>` : escapeHtml(record.mutationVerdict);
}

function operatorVerdictText(verdict: string): string {
  if (verdict === "do_not_apply") return "DO NOT APPLY";
  if (verdict === "no_apply") return "NO AUTO-APPLY";
  return verdict;
}

function reasonFor(record: DashboardRecord): string {
  const priority = ["forbidden_path", "malformed_diff", "dry_run_apply_failed", "verification_failed", "provider_rejected", "do_not_apply"];
  return priority.find((label) => record.safetyLabels.includes(label)) ?? record.outcome;
}

function rowClass(record: DashboardRecord): string {
  if (record.safetyLabels.includes("do_not_apply") || record.safetyLabels.includes("provider_rejected") || record.safetyLabels.includes("forbidden_path")) return "record-danger";
  if (record.outcome === "proposal_ready_verified") return "record-ready";
  return "record-neutral";
}

function searchText(record: DashboardRecord): string {
  return searchableRecordText(record);
}

function labelClass(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function isDoNotApplyVerdict(verdict: string): boolean {
  return verdict === "do_not_apply";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
