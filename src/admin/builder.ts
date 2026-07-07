import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildActionPreviews,
  buildActionQueueSummary,
  summarizeActionPreviews,
  type AdminActionPreview,
  type AdminActionQueueSummary,
  type AdminActionRunSummary
} from "./action-previews.js";
import { type AdminConfig, loadAdminConfig } from "./config.js";
import { redactJson, redactedRef } from "./redaction.js";
import { renderAdminHtml } from "./renderer.js";
import { normalizeArtifactLinks, type AdminArtifactLink } from "./run-browser.js";
import { buildRunDetail, type AdminRunDetail } from "./run-graph.js";
import { loadRuns, missingEvidence, unsafeMutation, type AdminRunRecord } from "./run-records.js";

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
  runs: Array<AdminRunRecord & { actionSummary?: AdminActionRunSummary }>;
  runDetails: AdminRunDetail[];
  artifactLinks: Record<string, AdminArtifactLink[]>;
  actionPreviews: Record<string, AdminActionPreview[]>;
  actionSummaries: Record<string, AdminActionRunSummary>;
  actionQueue: AdminActionQueueSummary;
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
  actionQueue: AdminActionQueueSummary;
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

export async function buildAdminUi(options: AdminBuildOptions): Promise<AdminBuildResult> {
  const data = await collectAdminData(options);
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const dataPath = join(out, "admin-data.json");
  const indexPath = join(out, "index.html");
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(indexPath, renderAdminHtml(data), "utf8");
  return { indexPath, dataPath, data };
}

export async function collectAdminData(options: Omit<AdminBuildOptions, "out"> & { out?: string }): Promise<AdminData> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const loadedConfig = await loadAdminConfig(options.config);
  const runs = await loadRuns(repoRoot, loadedConfig.config);
  const repositories = await Promise.all(loadedConfig.config.repositories.map((repo) => repoStatus(repo, runs)));
  const providers = loadedConfig.config.providers.map(providerStatus);
  const runDetails = await loadDetails(runs, options.maxDetails ?? 40);
  const detailsByPacket = new Map(runDetails.map((detail) => [detail.packetPath, detail]));
  const actionPreviews = Object.fromEntries(runs.map((run) => [run.id, buildActionPreviews(run, detailsByPacket.get(run.packetPath))]));
  const actionSummaries = Object.fromEntries(Object.entries(actionPreviews).map(([id, actions]) => [id, summarizeActionPreviews(actions)]));
  const actionQueue = buildActionQueueSummary(runs, actionSummaries);
  const allowedArtifactRoots = loadedConfig.config.runs.defaultRoots.map((root) => resolve(repoRoot, root));
  const data: AdminData = redactJson({
    schemaVersion: "runforge-admin-alpha",
    generatedAt: new Date().toISOString(),
    runForge: {
      repoPath: repoRoot,
      sha: await gitValue(repoRoot, ["rev-parse", "--short", "HEAD"], "unknown")
    },
    configPath: loadedConfig.path,
    configExists: loadedConfig.exists,
    overview: buildOverview(runs, providers.length, repositories.length, actionQueue),
    repositories,
    providers,
    runs: runs.map((run) => ({ ...run, actionSummary: actionSummaries[run.id] })),
    runDetails,
    artifactLinks: Object.fromEntries(runs.map((run) => [run.id, normalizeArtifactLinks(run, detailsByPacket.get(run.packetPath), allowedArtifactRoots)])),
    actionPreviews,
    actionSummaries,
    actionQueue,
    settings: {
      defaultRoots: loadedConfig.config.runs.defaultRoots,
      redactionPolicy: "API keys, bearer tokens, OpenRouter keys, .env-style secrets, and private keys are redacted before rendering.",
      config: loadedConfig.config,
      serverWritable: false
    }
  } satisfies AdminData);
  return data;
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

function buildOverview(runs: AdminRunRecord[], providerCount: number, repositoryCount: number, actionQueue: AdminActionQueueSummary): AdminOverview {
  return {
    repositoryCount,
    providerCount,
    indexedRunCount: runs.length,
    latestValidationAlpha: latestAlpha(runs),
    byOutcome: countBy(runs.map((run) => run.outcome)),
    byProviderStatus: countBy(runs.map((run) => run.providerStatus)),
    urgentSafetyCounts: {
      urgent: runs.filter((run) => run.urgent).length,
      do_not_apply: runs.filter((run) => run.doNotApply).length,
      provider_rejected: runs.filter((run) => run.providerRejected).length,
      verification_failed: runs.filter((run) => run.verificationFailed).length,
      setup_failed: runs.filter((run) => run.setupFailure).length,
      setup_failed_main_failed: runs.filter((run) => run.outcome === "setup_failed_main_failed").length,
      unsafe_mutation: runs.filter((run) => unsafeMutation(run.mutationVerdict)).length,
      missing_evidence: runs.filter((run) => missingEvidence(run.hasSummary, run.hasViewer, run.packetPath)).length
    },
    actionQueue
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
