import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { findSecretLikeContent } from "./okf-secret-scan.js";
import { handoffArchiveViewerCss, handoffArchiveViewerJs } from "./external-operator-handoff-archive-viewer-assets.js";
import type { HandoffArchiveCounts, HandoffArchiveRecord, HandoffArchiveResult } from "./external-operator-handoff-archive-types.js";

export interface HandoffArchiveViewerOptions {
  archive: string;
  out: string;
}
export interface HandoffArchiveViewerSummary {
  archivePath: string;
  archiveGeneratedAt: string;
  archiveRoot: string;
  generatedAt: string;
  safetyBanner: string;
  counts: HandoffArchiveCounts;
  findings: string[];
  recommendations: string[];
  filters: {
    repoSubstring: true;
    decisionVerdicts: string[];
    auditStatuses: string[];
    safetyStatuses: string[];
    validationStatuses: string[];
    originalMutationVerdicts: string[];
    zeroResultMessage: string;
  };
}
export interface HandoffArchiveViewerRecord extends HandoffArchiveRecord {
  mutationVerdict: "mutated" | "unchanged";
  displayValidationCommands: string[];
  missingOptionalFiles: string[];
}
export interface HandoffArchiveViewerValidationResult {
  passed: boolean;
  errors: string[];
}
export interface HandoffArchiveViewerResult {
  schemaVersion: "alpha-27-handoff-archive-viewer";
  generatedAt: string;
  archivePath: string;
  outDir: string;
  indexPath: string;
  summaryPath: string;
  recordsPath: string;
  assetPaths: string[];
  summary: HandoffArchiveViewerSummary;
  records: HandoffArchiveViewerRecord[];
  validation: HandoffArchiveViewerValidationResult;
}

const safetyBanner = "Read-only local viewer. It never applies patches, mutates original repositories, calls providers, pushes, merges, deploys, or promotes skills.";
const zeroResultMessage = "No handoff archive records match the current filters.";
export async function buildHandoffArchiveViewer(options: HandoffArchiveViewerOptions): Promise<HandoffArchiveViewerResult> {
  const archivePath = resolve(options.archive);
  const outDir = resolve(options.out);
  const archive = await readHandoffArchive(archivePath);
  const generatedAt = new Date().toISOString();
  const records = archive.records.map(toViewerRecord);
  const summary: HandoffArchiveViewerSummary = {
    archivePath,
    archiveGeneratedAt: archive.generatedAt,
    archiveRoot: archive.root,
    generatedAt,
    safetyBanner,
    counts: archive.counts,
    findings: archive.findings,
    recommendations: archive.recommendations,
    filters: {
      repoSubstring: true,
      decisionVerdicts: unique(records.map((record) => record.decisionVerdict)),
      auditStatuses: unique(records.map((record) => record.auditStatus)),
      safetyStatuses: unique(records.map((record) => record.safetyStatus)),
      validationStatuses: unique(records.map((record) => record.validationAfter)),
      originalMutationVerdicts: unique(records.map((record) => record.mutationVerdict)),
      zeroResultMessage
    }
  };

  await mkdir(join(outDir, "assets"), { recursive: true });
  const indexPath = join(outDir, "index.html");
  const summaryPath = join(outDir, "archive-summary.json");
  const recordsPath = join(outDir, "records.json");
  const cssPath = join(outDir, "assets", "viewer.css");
  const jsPath = join(outDir, "assets", "viewer.js");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await writeFile(cssPath, handoffArchiveViewerCss(), "utf8");
  await writeFile(jsPath, handoffArchiveViewerJs(), "utf8");
  await writeFile(indexPath, renderViewerHtml(summary, records), "utf8");

  const result: HandoffArchiveViewerResult = {
    schemaVersion: "alpha-27-handoff-archive-viewer",
    generatedAt,
    archivePath,
    outDir,
    indexPath,
    summaryPath,
    recordsPath,
    assetPaths: [cssPath, jsPath],
    summary,
    records,
    validation: { passed: true, errors: [] }
  };
  result.validation = await validateHandoffArchiveViewer(result);
  return result;
}
export async function validateHandoffArchiveViewer(input: HandoffArchiveViewerResult | { archivePath: string; outDir: string }): Promise<HandoffArchiveViewerValidationResult> {
  const outDir = resolve(input.outDir);
  const archivePath = resolve(input.archivePath);
  const errors: string[] = [];
  const indexPath = "indexPath" in input ? input.indexPath : join(outDir, "index.html");
  const summaryPath = "summaryPath" in input ? input.summaryPath : join(outDir, "archive-summary.json");
  const recordsPath = "recordsPath" in input ? input.recordsPath : join(outDir, "records.json");
  await expectFile(indexPath, errors, "index.html exists");
  await expectFile(summaryPath, errors, "archive-summary.json exists");
  await expectFile(recordsPath, errors, "records.json exists");

  const [archive, summary, records, html, css, js] = await Promise.all([
    readHandoffArchive(archivePath).catch((error) => {
      errors.push(`archive readable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    readOptionalJson<HandoffArchiveViewerSummary>(summaryPath, errors),
    readOptionalJson<HandoffArchiveViewerRecord[]>(recordsPath, errors),
    readOptionalText(indexPath),
    readOptionalText(join(outDir, "assets", "viewer.css")),
    readOptionalText(join(outDir, "assets", "viewer.js"))
  ]);

  if (archive && Array.isArray(records) && records.length !== archive.records.length) errors.push(`records count mismatch: archive=${archive.records.length} viewer=${records.length}`);
  if (summary && archive && summary.counts.records !== archive.records.length) errors.push(`summary count mismatch: archive=${archive.records.length} summary=${summary.counts.records}`);
  const generatedText = [html, css, js, JSON.stringify(summary ?? {}), JSON.stringify(records ?? [])].join("\n");
  if (/https?:\/\/|\/\/cdn\.|@import\s+url/i.test(generatedText)) errors.push("viewer references remote script/style/assets");
  if (/<(?:button|a|form)[^>]*(?:git\s+)?(?:push|merge|deploy)/i.test(generatedText)) errors.push("viewer exposes forbidden push/merge/deploy as an executable action");
  for (const finding of findSecretLikeContent(generatedText)) errors.push(`secret-like content matched ${finding}`);
  if (archive?.records.some((record) => record.safetyStatus === "unsafe") && !/data-safety-status="unsafe"|UNSAFE/.test(html)) errors.push("unsafe records are not visibly marked unsafe");
  if (!generatedText.includes(zeroResultMessage)) errors.push("zero-result filter state is not documented");
  return { passed: errors.length === 0, errors };
}
async function readHandoffArchive(path: string): Promise<HandoffArchiveResult> {
  const archive = JSON.parse(await readFile(path, "utf8")) as HandoffArchiveResult;
  if (archive.schemaVersion !== "alpha-26-handoff-archive" || !Array.isArray(archive.records)) throw new Error(`Invalid handoff archive at ${path}`);
  return archive;
}
async function expectFile(path: string, errors: string[], label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    errors.push(`${label}: missing ${path}`);
  }
}
async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
async function readOptionalJson<T>(path: string, errors: string[]): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    errors.push(`unable to read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
function toViewerRecord(record: HandoffArchiveRecord): HandoffArchiveViewerRecord {
  const validationCommands = record.validationCommands.map(sanitizeCommand);
  return {
    ...record,
    validationCommands,
    mutationVerdict: record.originalRepoMutated ? "mutated" : "unchanged",
    displayValidationCommands: validationCommands,
    missingOptionalFiles: optionalPaths(record).filter((item) => item.value === "unknown").map((item) => item.label)
  };
}
function sanitizeCommand(command: string): string {
  if (/\b(?:git\s+push|push|merge|deploy)\b/i.test(command)) return "[redacted unsafe command: see handoff and audit artifacts]";
  return command;
}
function optionalPaths(record: HandoffArchiveRecord): Array<{ label: string; value: string }> {
  return [
    { label: "operator decision", value: record.decisionPath },
    { label: "operator summary", value: record.operatorSummaryPath },
    { label: "lifecycle report", value: record.lifecycleReportPath },
    { label: "audit report", value: record.auditReportPath },
    { label: "audit result", value: record.auditResultPath },
    { label: "proposal patch", value: record.patchPath }
  ];
}

function renderViewerHtml(summary: HandoffArchiveViewerSummary, records: HandoffArchiveViewerRecord[]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunForge Operator Handoff Archive Viewer</title>
  <link rel="stylesheet" href="assets/viewer.css">
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">RunForge Alpha-27</p>
      <h1>Operator Handoff Archive Viewer</h1>
      <p class="meta">Generated ${escapeHtml(summary.generatedAt)} from ${escapeHtml(relativeOrBase(summary.archivePath))}</p>
    </div>
    <div class="safety" role="status">${escapeHtml(summary.safetyBanner)}</div>
  </header>
  <main>
    <section class="summary" aria-label="Archive summary">
      ${countGroup("Records", { total: summary.counts.records })}
      ${countGroup("By repo", summary.counts.byRepo)}
      ${countGroup("By decision", summary.counts.byDecision)}
      ${countGroup("By audit", summary.counts.byAuditStatus)}
      ${countGroup("By safety", summary.counts.bySafetyStatus)}
      ${countGroup("By validation after", summary.counts.byValidationAfter)}
    </section>

    <section class="filters" aria-label="Archive filters">
      <label>Repo <input id="filter-repo" type="search" placeholder="substring" autocomplete="off"></label>
      ${select("filter-decision", "Decision", summary.filters.decisionVerdicts)}
      ${select("filter-audit", "Audit", summary.filters.auditStatuses)}
      ${select("filter-safety", "Safety", summary.filters.safetyStatuses)}
      ${select("filter-validation", "Validation", summary.filters.validationStatuses)}
      ${select("filter-mutated", "Original repo", summary.filters.originalMutationVerdicts)}
      <button id="reset-filters" type="button">Reset</button>
    </section>

    <section class="records" aria-label="Archive records">
      <div class="record-count"><span id="visible-count">${records.length}</span> of ${records.length} records</div>
      <div id="empty-state" class="empty" hidden>${escapeHtml(summary.filters.zeroResultMessage)}</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Decision</th>
              <th>Audit</th>
              <th>Safety</th>
              <th>Validation</th>
              <th>Original repo</th>
              <th>Artifacts</th>
            </tr>
          </thead>
          <tbody>
            ${records.map(recordRow).join("\n")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="recommendations" aria-label="Findings and recommendations">
      <h2>Findings</h2>
      ${list(summary.findings)}
      <h2>OKF / Skills Recommendations</h2>
      ${list(summary.recommendations)}
      <h2>Source Metadata</h2>
      <dl>
        <dt>Archive root</dt><dd>${escapeHtml(summary.archiveRoot)}</dd>
        <dt>Archive generated</dt><dd>${escapeHtml(summary.archiveGeneratedAt)}</dd>
      </dl>
    </section>
  </main>
  <script type="application/json" id="viewer-records">${escapeHtml(JSON.stringify(records))}</script>
  <script src="assets/viewer.js"></script>
</body>
</html>
`;
}

function recordRow(record: HandoffArchiveViewerRecord): string {
  const validation = `${record.validationBefore} -> ${record.validationAfter}`;
  const details = [
    artifactLine("Handoff README", record.handoffReadmePath),
    artifactLine("Handoff JSON", record.handoffPath),
    artifactLine("Proposal patch", record.patchPath),
    artifactLine("Audit result", record.auditResultPath),
    artifactLine("Audit report", record.auditReportPath),
    artifactLine("Operator decision", record.decisionPath),
    artifactLine("Lifecycle evidence", record.lifecycleReportPath),
    detailList("Validation commands", record.displayValidationCommands),
    detailList("Lifecycle refs", record.lifecycleRefs),
    detailList("Safety notes", record.unsafeReasons.length > 0 ? record.unsafeReasons : ["No unsafe reasons recorded."]),
    detailList("Missing optional files", record.missingOptionalFiles.length > 0 ? record.missingOptionalFiles : ["None recorded."]),
    detailList("Record recommendations", record.recommendations)
  ].join("");
  return `<tr data-repo="${attr(record.repoPath)} ${attr(record.repoName)}" data-decision="${attr(record.decisionVerdict)}" data-audit="${attr(record.auditStatus)}" data-safety-status="${attr(record.safetyStatus)}" data-validation="${attr(record.validationAfter)}" data-mutated="${attr(record.mutationVerdict)}">
  <td><strong>${escapeHtml(record.repoName)}</strong><span>${escapeHtml(record.createdFromAlpha)}</span></td>
  <td>${badge(record.decisionVerdict)}</td>
  <td>${badge(record.auditStatus)}</td>
  <td>${badge(record.safetyStatus === "unsafe" ? "UNSAFE" : record.safetyStatus)}</td>
  <td>${escapeHtml(validation)}</td>
  <td>${escapeHtml(record.mutationVerdict)}</td>
  <td><details><summary>Paths and notes</summary>${details}</details></td>
</tr>`;
}

function artifactLine(label: string, path: string): string {
  const value = path && path !== "unknown" ? path : "missing";
  return `<div class="artifact"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`;
}

function detailList(label: string, values: string[]): string {
  return `<div class="detail-list"><span>${escapeHtml(label)}</span><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul></div>`;
}

function countGroup(title: string, counts: Record<string, number>): string {
  return `<div class="count-group"><h2>${escapeHtml(title)}</h2>${Object.entries(counts).map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`).join("")}</div>`;
}

function select(id: string, label: string, values: string[]): string {
  return `<label>${escapeHtml(label)} <select id="${id}"><option value="">Any</option>${values.map((value) => `<option value="${attr(value)}">${escapeHtml(value)}</option>`).join("")}</select></label>`;
}

function list(values: string[]): string {
  if (values.length === 0) return "<p>None recorded.</p>";
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function badge(value: string): string {
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function relativeOrBase(path: string): string {
  const cwd = process.cwd();
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : basename(path);
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function attr(value: unknown): string {
  return escapeHtml(value).replace(/\s+/g, " ");
}
