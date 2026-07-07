import type { HandoffArchiveCounts, HandoffArchiveRecord, HandoffArchiveSearchFilters } from "./external-operator-handoff-archive-types.js";

type JsonObject = Record<string, unknown>;

export function archiveCounts(records: HandoffArchiveRecord[]): HandoffArchiveCounts {
  return {
    records: records.length,
    byRepo: countBy(records, (record) => record.repoName),
    byDecision: countBy(records, (record) => record.decisionVerdict),
    byAuditStatus: countBy(records, (record) => record.auditStatus),
    bySafetyStatus: countBy(records, (record) => record.safetyStatus),
    byValidationAfter: countBy(records, (record) => record.validationAfter)
  };
}

export function archiveFindings(records: HandoffArchiveRecord[]): string[] {
  return records.flatMap((record) => record.findings.map((finding) => `${record.id}: ${finding}`));
}

export function archiveRecommendations(records: HandoffArchiveRecord[]): string[] {
  return [...new Set(records.flatMap((record) => record.recommendations))].sort();
}

export function recordRecommendations(repo: string, decision: string, audit: string, safety: string, reasons: string[]): string[] {
  if (decision === "accepted" && audit === "passed") return [`Candidate OKF lesson: accepted audited handoff flow works for repo ${repo}.`];
  if (safety === "unsafe") return [`Candidate safety lesson: rejected unsafe handoff for repo ${repo}; review ${reasons[0] ?? "archive unsafe reason"}.`];
  if (decision === "rejected" || audit === "failed") return [`Candidate lesson: declined or failed handoff for repo ${repo}; review validation and decision rules.`];
  return [`Candidate archive lesson: preserve handoff/audit evidence for repo ${repo}.`];
}

export function unsafeReasonsFor(handoff: JsonObject | null, audit: JsonObject | null): string[] {
  const reasons: string[] = [];
  const safety = objectValue(handoff?.safety);
  for (const key of ["providerUsed", "networkUsed", "dbUsed", "deployUsed", "pushUsed", "mergeUsed"]) {
    if (safety?.[key] === true) reasons.push(`handoff safety.${key}=true`);
  }
  if (objectValue(handoff?.proposal)?.autoAppliedByRunForge === true) reasons.push("handoff proposal autoAppliedByRunForge=true");
  if (objectValue(handoff?.sourceRepo)?.originalRepoMutated === true) reasons.push("handoff sourceRepo originalRepoMutated=true");
  if (objectValue(handoff?.manualApply)?.allowedTarget === "original_repo") reasons.push("handoff allows original_repo apply target");
  const auditSafety = objectValue(audit?.safety);
  if (auditSafety?.unsafeInstructionsFound === true) reasons.push("audit found unsafe instructions");
  if (auditSafety?.forbiddenTargetsFound === true) reasons.push("audit found forbidden targets");
  for (const finding of Array.isArray(audit?.findings) ? audit.findings.filter((item): item is string => typeof item === "string") : []) {
    if (/unsafe|forbidden|original_repo|autoAppliedByRunForge|git push|deploy/i.test(finding)) reasons.push(finding);
  }
  return [...new Set(reasons)];
}

export function matchesRecord(record: HandoffArchiveRecord, filters: HandoffArchiveSearchFilters): boolean {
  const repoMatches = !filters.repo || matchesText(record.repoPath, filters.repo) || matchesText(record.repoName, filters.repo);
  return repoMatches &&
    matchesText(record.decisionVerdict, filters.decision) &&
    matchesText(record.auditStatus, filters.auditStatus) &&
    matchesText(record.safetyStatus, filters.safetyStatus) &&
    matchesText(record.validationAfter, filters.validationStatus) &&
    matchesMutation(record.originalRepoMutated, filters.originalMutated);
}

function matchesText(actual: string, expected: string | undefined): boolean {
  if (!expected) return true;
  return actual.toLowerCase().includes(expected.toLowerCase());
}

function matchesMutation(actual: boolean, expected: string | undefined): boolean {
  if (!expected) return true;
  if (expected === "true" || expected === "mutated") return actual === true;
  if (expected === "false" || expected === "unchanged") return actual === false;
  return String(actual) === expected;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item) || "unknown"] = (counts[key(item) || "unknown"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
