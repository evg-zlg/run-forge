import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { AdminRunDetail } from "./run-graph.js";

export interface AdminArtifactLink {
  label: string;
  path: string;
  kind: string;
  exists?: boolean;
  route?: string;
}

export interface AdminRunRecordLike {
  id: string;
  alpha: string;
  repo: string;
  scenario: string;
  packetType: string;
  outcome: string;
  providerStatus: string;
  operatorVerdict: string;
  mutationVerdict: string;
  setupStatus: string;
  proposalStatus: string;
  safetyFlags: string[];
  createdAt: string;
  updatedAt: string;
  packetPath: string;
  summaryPath: string;
  viewerPath: string;
  dashboardPath: string;
  resultsPath: string;
  eventsPath: string;
  metricsPath: string;
  safetyReportPath: string;
  providerAuditPath: string;
  artifactCount: number;
  commandCount: number;
  doNotApply: boolean;
  providerRejected: boolean;
  verificationFailed: boolean;
  setupFailure: boolean;
  hasProposal: boolean;
  verifiedProposal: boolean;
  hasViewer: boolean;
  hasSummary: boolean;
  urgent: boolean;
}

export interface RunBrowserFilters {
  text?: string;
  repo?: string;
  alpha?: string;
  outcome?: string;
  providerStatus?: string;
  packetType?: string;
  operatorVerdict?: string;
  mutationVerdict?: string;
  hasDoNotApply?: boolean;
  hasProviderRejected?: boolean;
  hasVerificationFailed?: boolean;
  hasSetupFailure?: boolean;
  hasProposal?: boolean;
  hasVerifiedProposal?: boolean;
  hasViewer?: boolean;
  hasSummary?: boolean;
  urgentOnly?: boolean;
}

export type RunSort = "newest" | "outcome" | "repo" | "alpha" | "provider";

export interface AdminRunComparison {
  leftId: string;
  rightId: string;
  rows: Array<{
    field: string;
    left: string;
    right: string;
    changed: boolean;
  }>;
  changedCount: number;
}

const COMPARE_FIELDS: Array<[string, keyof AdminRunRecordLike]> = [
  ["Repo", "repo"],
  ["Alpha", "alpha"],
  ["Scenario", "scenario"],
  ["Outcome", "outcome"],
  ["Provider status", "providerStatus"],
  ["Safety flags", "safetyFlags"],
  ["Mutation verdict", "mutationVerdict"],
  ["Operator verdict", "operatorVerdict"],
  ["Setup status", "setupStatus"],
  ["Proposal status", "proposalStatus"],
  ["Command count", "commandCount"],
  ["Artifact count", "artifactCount"],
  ["Packet path", "packetPath"],
  ["Summary path", "summaryPath"],
  ["Viewer path", "viewerPath"],
  ["Dashboard path", "dashboardPath"]
];

export function filterRuns<T extends AdminRunRecordLike>(runs: T[], filters: RunBrowserFilters): T[] {
  const query = (filters.text ?? "").trim().toLowerCase();
  return runs.filter((run) => {
    const textMatch = !query || [
      run.id,
      run.alpha,
      run.repo,
      run.scenario,
      run.packetType,
      run.outcome,
      run.providerStatus,
      run.operatorVerdict,
      run.mutationVerdict,
      run.setupStatus,
      run.proposalStatus,
      run.safetyFlags.join(" "),
      run.packetPath,
      run.summaryPath,
      run.viewerPath,
      run.dashboardPath
    ].join(" ").toLowerCase().includes(query);
    return textMatch
      && matches(filters.repo, run.repo)
      && matches(filters.alpha, run.alpha)
      && matches(filters.outcome, run.outcome)
      && matches(filters.providerStatus, run.providerStatus)
      && matches(filters.packetType, run.packetType)
      && matches(filters.operatorVerdict, run.operatorVerdict)
      && matches(filters.mutationVerdict, run.mutationVerdict)
      && (!filters.hasDoNotApply || run.doNotApply)
      && (!filters.hasProviderRejected || run.providerRejected)
      && (!filters.hasVerificationFailed || run.verificationFailed)
      && (!filters.hasSetupFailure || run.setupFailure)
      && (!filters.hasProposal || run.hasProposal)
      && (!filters.hasVerifiedProposal || run.verifiedProposal)
      && (!filters.hasViewer || run.hasViewer)
      && (!filters.hasSummary || run.hasSummary)
      && (!filters.urgentOnly || run.urgent);
  });
}

export function sortRuns<T extends AdminRunRecordLike>(runs: T[], sort: RunSort): T[] {
  return [...runs].sort((left, right) => {
    if (sort === "outcome") return byText(left.outcome, right.outcome) || newest(left, right);
    if (sort === "repo") return byText(left.repo, right.repo) || newest(left, right);
    if (sort === "alpha") return byText(left.alpha, right.alpha) || newest(left, right);
    if (sort === "provider") return byText(left.providerStatus, right.providerStatus) || newest(left, right);
    return newest(left, right);
  });
}

export function compareRuns(left: AdminRunRecordLike, right: AdminRunRecordLike): AdminRunComparison {
  const rows = COMPARE_FIELDS.map(([field, key]) => {
    const leftValue = stringifyCompareValue(left[key]);
    const rightValue = stringifyCompareValue(right[key]);
    return {
      field,
      left: leftValue,
      right: rightValue,
      changed: leftValue !== rightValue
    };
  });
  return {
    leftId: left.id,
    rightId: right.id,
    rows,
    changedCount: rows.filter((row) => row.changed).length
  };
}

export function normalizeArtifactLinks(run: AdminRunRecordLike, detail?: AdminRunDetail, allowedRoots: string[] = []): AdminArtifactLink[] {
  const links = new Map<string, AdminArtifactLink>();
  const add = (label: string, path: string, kind: string, exists?: boolean) => {
    if (!path || path === "unknown") return;
    const normalized = normalize(path);
    const route = allowedRoots.length > 0 && artifactPathAllowed(normalized, allowedRoots) ? `/api/admin/artifact?path=${encodeURIComponent(normalized)}` : undefined;
    links.set(`${label}\0${normalized}`, { label, path: normalized, kind, exists, route });
  };
  add("Packet", run.packetPath, "packet", true);
  add("Summary", run.summaryPath, "summary", run.hasSummary);
  add("Viewer", run.viewerPath, "viewer", run.hasViewer);
  add("Dashboard", run.dashboardPath, "dashboard");
  add("Results", run.resultsPath, "results");
  add("Events", run.eventsPath, "events");
  add("Metrics", run.metricsPath, "metrics");
  add("Safety report", run.safetyReportPath, "safety");
  add("Provider audit", run.providerAuditPath, "provider_audit");
  for (const artifact of detail?.artifacts ?? []) {
    const path = isAbsolute(artifact) ? artifact : join(run.packetPath, artifact);
    add(basename(path) || "Artifact", path, "artifact", true);
  }
  return [...links.values()];
}

export function artifactPathAllowed(path: string, roots: string[]): boolean {
  const resolvedPath = resolve(path);
  return roots.some((root) => isInside(resolvedPath, resolve(root)));
}

export function packetSibling(packetPath: string, fileName: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return join(packetPath, fileName);
}

export function runSibling(packetPath: string, fileName: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return join(dirname(packetPath), fileName);
}

function matches(filter: string | undefined, value: string): boolean {
  return !filter || value === filter;
}

function newest(left: AdminRunRecordLike, right: AdminRunRecordLike): number {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "") || 0;
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "") || 0;
  return rightTime - leftTime || byText(right.alpha, left.alpha) || byText(left.scenario, right.scenario);
}

function byText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function stringifyCompareValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  return String(value ?? "unknown");
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
