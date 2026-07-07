import type { DashboardSeedRecord } from "./packet-query.js";

export function safetyLabels(record: DashboardSeedRecord): string[] {
  const labels = new Set<string>();
  const text = searchableRecordText(record);
  if (record.mutationVerdict === "unchanged") labels.add("unchanged");
  if (record.operatorVerdict === "do_not_apply" || record.operatorVerdict === "no_apply") labels.add("do_not_apply");
  if (record.providerStatus === "rejected" || record.outcome === "provider_rejected") {
    labels.add("provider_rejected");
    labels.add("provider rejected");
  }
  if (record.outcome === "verification_failed" || text.includes("verification_failed") || text.includes("verification failed")) labels.add("verification_failed");
  if (record.outcome === "dry_run_apply_failed" || text.includes("dry-run") || text.includes("dry_run_apply_failed")) labels.add("dry_run_apply_failed");
  if (record.outcome === "malformed_diff" || text.includes("malformed") || text.includes("bad hunk")) labels.add("malformed_diff");
  if (record.outcome === "forbidden_path" || text.includes("forbidden")) labels.add("forbidden_path");
  if (record.outcome === "proposal_ready_verified") labels.add("proposal_ready_verified");
  if (isDoNotApplyOrUnsafe(record)) labels.add("do_not_apply");
  return [...labels].sort();
}

export function isFailedOrUnsafe(record: DashboardSeedRecord): boolean {
  const text = `${record.outcome} ${record.providerStatus} ${record.operatorVerdict} ${record.mutationVerdict} ${record.tags.join(" ")}`.toLowerCase();
  return text.includes("rejected") || text.includes("failed") || text.includes("unsafe") || text.includes("forbidden") || text.includes("do_not_apply");
}

export function isDoNotApplyOrUnsafe(record: DashboardSeedRecord): boolean {
  const text = searchableRecordText(record);
  return text.includes("do_not_apply") || text.includes("unsafe") || text.includes("forbidden");
}

export function searchableRecordText(record: DashboardSeedRecord): string {
  const raw = record as unknown as Record<string, unknown>;
  return [
    record.repo,
    record.scenario,
    record.outcome,
    record.providerStatus,
    record.operatorVerdict,
    record.mutationVerdict,
    typeof raw.setupNetworkIntent === "string" ? raw.setupNetworkIntent : "",
    typeof raw.setupDiagnosticMode === "string" ? raw.setupDiagnosticMode : "",
    typeof raw.handoffReadmePath === "string" ? raw.handoffReadmePath : "",
    typeof raw.handoffJsonPath === "string" ? raw.handoffJsonPath : "",
    typeof raw.handoffAuditStatus === "string" ? raw.handoffAuditStatus : "",
    typeof raw.handoffAuditReportPath === "string" ? raw.handoffAuditReportPath : "",
    typeof raw.handoffAuditResultPath === "string" ? raw.handoffAuditResultPath : "",
    ...(Array.isArray(record.tags) ? record.tags : []),
    typeof raw.notes === "string" ? raw.notes : ""
  ].join(" ").toLowerCase();
}

export function latestAlpha(alphas: string[]): string {
  return [...new Set(alphas)].sort((a, b) => alphaNumber(a) - alphaNumber(b) || a.localeCompare(b)).at(-1) ?? "unknown";
}

export function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyFor(item) || "unknown"] = (counts[keyFor(item) || "unknown"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function stringField(record: DashboardSeedRecord, key: string): string {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function alphaNumber(alpha: string): number {
  const match = /^ALPHA-(\d+)/.exec(alpha);
  return match ? Number(match[1]) : -1;
}
