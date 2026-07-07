import type { HandoffArchiveResult, HandoffArchiveSearchResult } from "./external-operator-handoff-archive-types.js";

export function renderHandoffArchiveMarkdown(archive: HandoffArchiveResult): string {
  return [
    "# Operator Handoff Archive",
    "",
    `Generated at: ${archive.generatedAt}`,
    `Root: ${archive.root}`,
    "",
    "## Counts",
    "",
    `- records: ${archive.counts.records}`,
    ...countLines("by repo", archive.counts.byRepo),
    ...countLines("by decision", archive.counts.byDecision),
    ...countLines("by audit", archive.counts.byAuditStatus),
    ...countLines("by safety", archive.counts.bySafetyStatus),
    ...countLines("by validation after", archive.counts.byValidationAfter),
    "",
    "## Records",
    "",
    "| ID | Repo | Decision | Audit | Safety | Validation | Handoff | Audit report |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...archive.records.map((record) => [
      record.id,
      record.repoName,
      record.decisionVerdict,
      record.auditStatus,
      record.safetyStatus,
      `${record.validationBefore}->${record.validationAfter}`,
      record.handoffReadmePath,
      record.auditReportPath
    ].map(markdownCell).join(" | ")),
    "",
    "## Recommendations",
    "",
    ...(archive.recommendations.length > 0 ? archive.recommendations.map((item) => `- ${item}`) : ["- No archive recommendations."]),
    "",
    `Validation: ${archive.validation.passed ? "passed" : "failed"}`
  ].join("\n") + "\n";
}

export function renderHandoffSearchMarkdown(result: HandoffArchiveSearchResult): string {
  return [
    "# Operator Handoff Search",
    "",
    `Archive: ${result.archivePath}`,
    `Matches: ${result.matchingCount}`,
    `Filters: ${JSON.stringify(result.filters)}`,
    "",
    ...(result.records.length === 0 ? ["No handoff archive records match the filters."] : [
      "| ID | Repo | Decision | Audit | Safety | Validation |",
      "| --- | --- | --- | --- | --- | --- |",
      ...result.records.map((record) => [record.id, record.repoName, record.decisionVerdict, record.auditStatus, record.safetyStatus, `${record.validationBefore}->${record.validationAfter}`].map(markdownCell).join(" | "))
    ])
  ].join("\n") + "\n";
}

export function renderHandoffSearchTable(result: HandoffArchiveSearchResult): string {
  if (result.records.length === 0) return `No handoff archive records match filters ${JSON.stringify(result.filters)}.`;
  return [
    `Found ${result.matchingCount} handoff archive record(s).`,
    ...result.records.map((record) => `${record.id} repo=${record.repoName} decision=${record.decisionVerdict} audit=${record.auditStatus} safety=${record.safetyStatus} validation=${record.validationBefore}->${record.validationAfter}`)
  ].join("\n");
}

function countLines(title: string, counts: Record<string, number>): string[] {
  return Object.entries(counts).map(([key, value]) => `- ${title}: ${key} = ${value}`);
}

function markdownCell(value: string): string {
  return String(value).replaceAll("|", "\\|");
}
