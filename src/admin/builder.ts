import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildPacketIndex, type PacketIndexEntry } from "../run/packet-indexer.js";
import { type AdminConfig, loadAdminConfig } from "./config.js";
import { redactJson, redactedRef } from "./redaction.js";
import { renderAdminHtml } from "./renderer.js";
import { buildRunDetail, type AdminRunDetail } from "./run-graph.js";

const execFileAsync = promisify(execFile);

export interface AdminBuildOptions {
  config?: string;
  out: string;
  repoRoot?: string;
  maxDetails?: number;
}

export interface AdminBuildResult {
  indexPath: string;
  dataPath: string;
  data: AdminData;
}

export interface AdminData {
  schemaVersion: "runforge-admin-alpha";
  generatedAt: string;
  runForge: {
    repoPath: string;
    sha: string;
  };
  configPath: string;
  configExists: boolean;
  overview: AdminOverview;
  repositories: AdminRepositoryStatus[];
  providers: AdminProviderStatus[];
  runs: AdminRunRecord[];
  runDetails: AdminRunDetail[];
  settings: {
    defaultRoots: string[];
    redactionPolicy: string;
    config: AdminConfig;
    serverWritable: boolean;
  };
}

export interface AdminOverview {
  repositoryCount: number;
  providerCount: number;
  indexedRunCount: number;
  latestValidationAlpha: string;
  byOutcome: Record<string, number>;
  byProviderStatus: Record<string, number>;
  urgentSafetyCounts: Record<string, number>;
}

export interface AdminRepositoryStatus {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  gitHead: string;
  gitStatus: "clean" | "dirty" | "missing" | "not_git" | "unknown";
  tags: string[];
  lastObservedRun: string;
}

export interface AdminProviderStatus {
  id: string;
  type: string;
  enabled: boolean;
  apiKeyRef: string;
  tokenStatus: "present" | "missing" | "not_configured" | "local_reference" | "not_applicable";
  defaultModel: string;
  command: string;
}

export interface AdminRunRecord {
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
  doNotApply: boolean;
  verifiedProposal: boolean;
  setupFailure: boolean;
}

export async function buildAdminUi(options: AdminBuildOptions): Promise<AdminBuildResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const out = resolve(options.out);
  const loadedConfig = await loadAdminConfig(options.config);
  const runs = await loadRuns(repoRoot, loadedConfig.config);
  const repositories = await Promise.all(loadedConfig.config.repositories.map((repo) => repoStatus(repo, runs)));
  const providers = loadedConfig.config.providers.map(providerStatus);
  const runDetails = await loadDetails(runs, options.maxDetails ?? 20);
  const data: AdminData = redactJson({
    schemaVersion: "runforge-admin-alpha",
    generatedAt: new Date().toISOString(),
    runForge: {
      repoPath: repoRoot,
      sha: await gitValue(repoRoot, ["rev-parse", "--short", "HEAD"], "unknown")
    },
    configPath: loadedConfig.path,
    configExists: loadedConfig.exists,
    overview: buildOverview(runs, providers.length, repositories.length),
    repositories,
    providers,
    runs,
    runDetails,
    settings: {
      defaultRoots: loadedConfig.config.runs.defaultRoots,
      redactionPolicy: "API keys, bearer tokens, OpenRouter keys, .env-style secrets, and private keys are redacted before rendering.",
      config: loadedConfig.config,
      serverWritable: false
    }
  } satisfies AdminData);

  await mkdir(out, { recursive: true });
  const dataPath = join(out, "admin-data.json");
  const indexPath = join(out, "index.html");
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(indexPath, renderAdminHtml(data), "utf8");
  return { indexPath, dataPath, data };
}

async function loadRuns(repoRoot: string, config: AdminConfig): Promise<AdminRunRecord[]> {
  const entries: PacketIndexEntry[] = [];
  for (const root of config.runs.defaultRoots) {
    const absoluteRoot = resolve(repoRoot, root);
    try {
      const info = await stat(absoluteRoot);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    const index = await buildPacketIndex({ root: absoluteRoot });
    entries.push(...index.entries);
  }
  return dedupe(entries).map((entry) => ({
    alpha: entry.milestone,
    repo: shortRepo(entry.repo),
    scenario: entry.scenario,
    packetType: entry.packetType,
    outcome: entry.outcome,
    providerStatus: entry.providerStatus,
    operatorVerdict: entry.decision,
    mutationVerdict: entry.externalRepoMutationVerdict,
    packetPath: entry.packetPath,
    viewerPath: entry.viewerPath,
    summaryPath: summaryForPacket(entry.packetPath),
    doNotApply: entry.decision === "do_not_apply" || entry.outcome === "do_not_apply",
    verifiedProposal: entry.outcome === "proposal_ready_verified",
    setupFailure: entry.outcome.includes("setup_failed")
  }));
}

async function repoStatus(repo: AdminConfig["repositories"][number], runs: AdminRunRecord[]): Promise<AdminRepositoryStatus> {
  const absolutePath = resolve(repo.path);
  let exists = false;
  try {
    exists = (await stat(absolutePath)).isDirectory();
  } catch {
    exists = false;
  }
  const head = exists ? await gitValue(absolutePath, ["rev-parse", "--short", "HEAD"], "") : "";
  const statusOutput = exists ? await gitValue(absolutePath, ["status", "--porcelain"], "__unknown__") : "";
  const gitStatus: AdminRepositoryStatus["gitStatus"] = !exists
    ? "missing"
    : head === ""
      ? "not_git"
      : statusOutput === "__unknown__"
        ? "unknown"
        : statusOutput.trim()
          ? "dirty"
          : "clean";
  const lastObservedRun = latestRepoRun(runs, repo.id, repo.name, basename(repo.path));
  return {
    id: repo.id,
    name: repo.name,
    path: absolutePath,
    exists,
    gitHead: head || "n/a",
    gitStatus,
    tags: repo.tags,
    lastObservedRun: lastObservedRun ? `${lastObservedRun.alpha} / ${lastObservedRun.scenario}` : "none"
  };
}

function providerStatus(provider: AdminConfig["providers"][number]): AdminProviderStatus {
  const ref = provider.apiKeyRef ?? null;
  let tokenStatus: AdminProviderStatus["tokenStatus"] = "not_applicable";
  if (provider.type === "openrouter") {
    if (!ref) tokenStatus = "not_configured";
    else if (ref.startsWith("env:")) tokenStatus = process.env[ref.slice(4)] ? "present" : "missing";
    else if (ref.startsWith("local:")) tokenStatus = "local_reference";
    else tokenStatus = "missing";
  }
  return {
    id: provider.id,
    type: provider.type,
    enabled: provider.enabled,
    apiKeyRef: redactedRef(ref),
    tokenStatus,
    defaultModel: provider.defaultModel ?? "not configured",
    command: provider.command ?? "not configured"
  };
}

function buildOverview(runs: AdminRunRecord[], providerCount: number, repositoryCount: number): AdminOverview {
  return {
    repositoryCount,
    providerCount,
    indexedRunCount: runs.length,
    latestValidationAlpha: latestAlpha(runs),
    byOutcome: countBy(runs.map((run) => run.outcome)),
    byProviderStatus: countBy(runs.map((run) => run.providerStatus)),
    urgentSafetyCounts: {
      do_not_apply: runs.filter((run) => run.operatorVerdict === "do_not_apply" || run.doNotApply).length,
      provider_rejected: runs.filter((run) => run.outcome === "provider_rejected" || run.providerStatus === "rejected").length,
      verification_failed: runs.filter((run) => run.outcome === "verification_failed").length,
      setup_failed: runs.filter((run) => run.outcome === "setup_failed").length,
      setup_failed_main_failed: runs.filter((run) => run.outcome === "setup_failed_main_failed").length
    }
  };
}

async function loadDetails(runs: AdminRunRecord[], maxDetails: number): Promise<AdminRunDetail[]> {
  const details: AdminRunDetail[] = [];
  for (const run of runs.filter((item) => item.packetPath !== "unknown").slice(0, maxDetails)) {
    try {
      details.push(await buildRunDetail(run.packetPath));
    } catch {
      // Missing old packet artifacts should not break the operator console.
    }
  }
  return details;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value || "unknown"] = (counts[value || "unknown"] ?? 0) + 1;
    return counts;
  }, {});
}

function latestAlpha(runs: AdminRunRecord[]): string {
  return runs.map((run) => run.alpha).filter((alpha) => alpha.startsWith("ALPHA-")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? "none";
}

function dedupe(entries: PacketIndexEntry[]): PacketIndexEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.milestone}\0${entry.scenario}\0${entry.packetPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summaryForPacket(packetPath: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return join(packetPath, "..", "summary.md");
}

function shortRepo(repo: string): string {
  if (!repo || repo === "unknown") return "unknown";
  return basename(repo) || repo;
}

function latestRepoRun(runs: AdminRunRecord[], ...names: string[]): AdminRunRecord | undefined {
  const wanted = new Set(names.filter(Boolean));
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (wanted.has(run.repo)) return run;
  }
  return undefined;
}

async function gitValue(cwd: string, args: string[], fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return String(result.stdout).trim();
  } catch {
    return fallback;
  }
}
