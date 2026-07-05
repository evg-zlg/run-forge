import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildPacketIndex, type PacketIndexEntry, type PacketIndexResult } from "./packet-indexer.js";
import { renderLatestDogfoodMarkdown, renderPacketQueryMarkdown } from "./packet-query-renderer.js";

export type PacketQueryFormat = "table" | "json" | "md";

export interface PacketQueryFilters {
  repo?: string;
  outcome?: string;
  providerStatus?: string;
  mutationVerdict?: string;
  scenario?: string;
  alpha?: string;
}

export interface PacketQueryOptions {
  index: string;
  out?: string;
  format?: PacketQueryFormat;
  filters?: PacketQueryFilters;
}

export interface PacketQueryRecord {
  alpha: string;
  scenario: string;
  repo: string;
  outcome: string;
  providerStatus: string;
  packetPath: string;
  viewerPath: string;
  mutationVerdict: string;
  operatorVerdict: string;
  notes: string;
}

export interface PacketQueryResult {
  schemaVersion: "packet-query-v1";
  generatedAt: string;
  indexPath: string;
  matchingCount: number;
  filters: PacketQueryFilters;
  records: PacketQueryRecord[];
}

export interface LatestDogfoodOptions {
  root: string;
  out?: string;
}

export interface LatestDogfoodResult {
  schemaVersion: "latest-dogfood-v1";
  generatedAt: string;
  root: string;
  latestAlpha: string;
  dogfoodCaseCount: number;
  counts: {
    byOutcome: Record<string, number>;
    byProviderStatus: Record<string, number>;
    byMutationVerdict: Record<string, number>;
  };
  reposTested: string[];
  latestVerifiedProposal: PacketQueryRecord | null;
  latestProviderRejection: PacketQueryRecord | null;
  failedOrUnsafeProposals: PacketQueryRecord[];
  originalReposStayedUnchanged: boolean;
  artifacts: Array<{
    alpha: string;
    scenario: string;
    packetPath: string;
    viewerPath: string;
  }>;
}

export interface DashboardSeedOptions {
  root: string;
  out?: string;
}

export interface DashboardSeedRecord {
  id: string;
  alpha: string;
  repo: string;
  scenario: string;
  packetType: string;
  outcome: string;
  providerStatus: string;
  operatorVerdict: string;
  mutationVerdict: string;
  packetPath: string;
  viewerPath: string;
  summaryPath: string;
  tags: string[];
}

export interface DashboardSeedResult {
  schemaVersion: "alpha-11-dashboard-seed";
  generatedAt: string;
  records: DashboardSeedRecord[];
  summary: {
    total: number;
    byOutcome: Record<string, number>;
    byRepo: Record<string, number>;
    byProviderStatus: Record<string, number>;
  };
}

export async function queryPacketIndex(options: PacketQueryOptions): Promise<PacketQueryResult> {
  const indexPath = resolve(options.index);
  const index = await readPacketIndex(indexPath);
  const filters = compactFilters(options.filters ?? {});
  const records = index.entries
    .filter((entry) => matchesFilters(entry, filters))
    .map(toQueryRecord);
  const result: PacketQueryResult = {
    schemaVersion: "packet-query-v1",
    generatedAt: new Date().toISOString(),
    indexPath,
    matchingCount: records.length,
    filters,
    records
  };

  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "query.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(out, "query.md"), renderPacketQueryMarkdown(result), "utf8");
  }

  return result;
}

export async function buildLatestDogfoodReport(options: LatestDogfoodOptions): Promise<LatestDogfoodResult> {
  const root = resolve(options.root);
  const index = await buildPacketIndex({ root });
  const dogfoodEntries = index.entries.filter(isDogfoodEvidence);
  const latestAlpha = latestMilestone(dogfoodEntries.map((entry) => entry.milestone));
  const latestEntries = latestAlpha === "unknown" ? dogfoodEntries : dogfoodEntries.filter((entry) => entry.milestone === latestAlpha);
  const latestRecords = latestEntries.map(toQueryRecord);
  const result: LatestDogfoodResult = {
    schemaVersion: "latest-dogfood-v1",
    generatedAt: new Date().toISOString(),
    root,
    latestAlpha,
    dogfoodCaseCount: dogfoodEntries.length,
    counts: {
      byOutcome: countBy(dogfoodEntries, (entry) => entry.outcome),
      byProviderStatus: countBy(dogfoodEntries, (entry) => entry.providerStatus),
      byMutationVerdict: countBy(dogfoodEntries, (entry) => entry.externalRepoMutationVerdict)
    },
    reposTested: [...new Set(dogfoodEntries.map((entry) => repoName(entry.repo)))].sort(),
    latestVerifiedProposal: latestRecords.find((record) => record.outcome === "proposal_ready_verified") ?? null,
    latestProviderRejection: latestRecords.find((record) => record.outcome === "provider_rejected" || record.providerStatus === "rejected") ?? null,
    failedOrUnsafeProposals: latestRecords.filter((record) => isFailedOrUnsafe(record)),
    originalReposStayedUnchanged: dogfoodEntries.length > 0 && dogfoodEntries.every((entry) => entry.externalRepoMutationVerdict === "unchanged"),
    artifacts: dogfoodEntries.map((entry) => ({
      alpha: entry.milestone,
      scenario: entry.scenario,
      packetPath: entry.packetPath,
      viewerPath: entry.viewerPath
    }))
  };

  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "latest-dogfood.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(out, "latest-dogfood.md"), renderLatestDogfoodMarkdown(result), "utf8");
  }

  return result;
}

export async function buildDashboardSeed(options: DashboardSeedOptions): Promise<DashboardSeedResult> {
  const index = await buildPacketIndex({ root: options.root });
  const records = index.entries.filter(isDogfoodEvidence).map((entry) => toDashboardSeedRecord(entry, index.root));
  const result: DashboardSeedResult = {
    schemaVersion: "alpha-11-dashboard-seed",
    generatedAt: new Date().toISOString(),
    records,
    summary: {
      total: records.length,
      byOutcome: countBy(records, (record) => record.outcome),
      byRepo: countBy(records, (record) => record.repo),
      byProviderStatus: countBy(records, (record) => record.providerStatus)
    }
  };

  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "dashboard-seed.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

async function readPacketIndex(path: string): Promise<PacketIndexResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read packet index at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = JSON.parse(raw) as PacketIndexResult;
  if (parsed.schemaVersion !== "packet-index-v1" || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid packet index at ${path}: expected schemaVersion packet-index-v1 with entries array.`);
  }
  return parsed;
}

function compactFilters(filters: PacketQueryFilters): PacketQueryFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "")) as PacketQueryFilters;
}

function matchesFilters(entry: PacketIndexEntry, filters: PacketQueryFilters): boolean {
  return (
    matchesText(entry.repo, filters.repo) &&
    matchesText(entry.outcome, filters.outcome) &&
    matchesText(entry.providerStatus, filters.providerStatus) &&
    matchesText(entry.externalRepoMutationVerdict, filters.mutationVerdict) &&
    matchesText(entry.scenario, filters.scenario) &&
    matchesText(entry.milestone, filters.alpha)
  );
}

function matchesText(actual: string, expected: string | undefined): boolean {
  if (!expected) return true;
  return actual === expected || actual.includes(expected);
}

function toQueryRecord(entry: PacketIndexEntry): PacketQueryRecord {
  return {
    alpha: entry.milestone,
    scenario: entry.scenario,
    repo: repoName(entry.repo),
    outcome: entry.outcome,
    providerStatus: entry.providerStatus,
    packetPath: entry.packetPath,
    viewerPath: entry.viewerPath,
    mutationVerdict: entry.externalRepoMutationVerdict,
    operatorVerdict: entry.decision,
    notes: entry.notes
  };
}

function toDashboardSeedRecord(entry: PacketIndexEntry, root: string): DashboardSeedRecord {
  return {
    id: `${entry.milestone}:${entry.scenario}`,
    alpha: entry.milestone,
    repo: repoName(entry.repo),
    scenario: entry.scenario,
    packetType: entry.packetType,
    outcome: entry.outcome,
    providerStatus: entry.providerStatus,
    operatorVerdict: entry.decision,
    mutationVerdict: entry.externalRepoMutationVerdict,
    packetPath: entry.packetPath,
    viewerPath: entry.viewerPath,
    summaryPath: join(root, entry.milestone, "summary.md"),
    tags: seedTags(entry)
  };
}

function seedTags(entry: PacketIndexEntry): string[] {
  const tags = new Set<string>();
  if (entry.outcome !== "unknown") tags.add(entry.outcome);
  if (entry.providerStatus !== "unknown") tags.add(`provider:${entry.providerStatus}`);
  if (entry.externalRepoMutationVerdict !== "unknown") tags.add(`mutation:${entry.externalRepoMutationVerdict}`);
  return [...tags].sort();
}

function isDogfoodEvidence(entry: PacketIndexEntry): boolean {
  return entry.milestone.startsWith("ALPHA-") && entry.repo !== "unknown" && entry.packetPath !== "unknown";
}

function isFailedOrUnsafe(record: PacketQueryRecord): boolean {
  const text = `${record.outcome} ${record.providerStatus} ${record.operatorVerdict}`.toLowerCase();
  return text.includes("rejected") || text.includes("failed") || text.includes("unsafe") || text.includes("forbidden") || text.includes("malformed");
}

function latestMilestone(milestones: string[]): string {
  const sorted = [...new Set(milestones)].sort((a, b) => milestoneNumber(a) - milestoneNumber(b) || a.localeCompare(b));
  return sorted.at(-1) ?? "unknown";
}

function milestoneNumber(milestone: string): number {
  const match = /^ALPHA-(\d+)/.exec(milestone);
  return match ? Number(match[1]) : -1;
}

function repoName(repo: string): string {
  if (repo === "unknown") return repo;
  return basename(repo);
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
