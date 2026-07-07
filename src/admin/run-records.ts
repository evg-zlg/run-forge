import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildPacketIndex, type PacketIndexEntry } from "../run/packet-indexer.js";
import type { AdminConfig } from "./config.js";
import { packetSibling, runSibling, sortRuns } from "./run-browser.js";

export interface AdminRunRecord {
  id: string;
  alpha: string;
  repo: string;
  repoPath: string;
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
  resultsPath: string;
  viewerPath: string;
  summaryPath: string;
  dashboardPath: string;
  eventsPath: string;
  metricsPath: string;
  safetyReportPath: string;
  providerAuditPath: string;
  artifactCount: number;
  commandCount: number;
  doNotApply: boolean;
  providerRejected: boolean;
  verificationFailed: boolean;
  verifiedProposal: boolean;
  hasProposal: boolean;
  setupFailure: boolean;
  hasViewer: boolean;
  hasSummary: boolean;
  urgent: boolean;
}

export async function loadRuns(repoRoot: string, config: AdminConfig): Promise<AdminRunRecord[]> {
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
  const records = await Promise.all(dedupe(entries).map((entry) => runRecord(entry)));
  return sortRuns(records, "newest").sort((left, right) => Number(right.urgent) - Number(left.urgent));
}

export function unsafeMutation(verdict: string): boolean {
  return !["unknown", "unchanged", "clean", "none", "not_applicable", "no_mutation"].includes(verdict);
}

export function missingEvidence(hasSummary: boolean, hasViewer: boolean, packetPath: string): boolean {
  return packetPath !== "unknown" && (!hasSummary || !hasViewer);
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

async function runRecord(entry: PacketIndexEntry): Promise<AdminRunRecord> {
  const summaryPath = summaryForPacket(entry.packetPath);
  const viewerPath = entry.viewerPath;
  const dashboardPath = dashboardForPacket(entry.packetPath);
  const resultsPath = resultsForPacket(entry.packetPath);
  const eventsPath = packetSibling(entry.packetPath, "events.jsonl");
  const metricsPath = packetSibling(entry.packetPath, "metrics.json");
  const safetyReportPath = packetSibling(entry.packetPath, "safety-report.json");
  const providerAuditPath = packetSibling(entry.packetPath, "provider-safety-report.json");
  const proposalStatus = proposalStatusFor(entry);
  const setupStatus = setupStatusFor(entry);
  const safetyFlags = safetyFlagsFor(entry, setupStatus, proposalStatus);
  const updatedAt = await newestMtime([entry.packetPath, summaryPath, viewerPath, dashboardPath, resultsPath, eventsPath, metricsPath, safetyReportPath, providerAuditPath]);
  const artifactCount = await countExisting([summaryPath, viewerPath, dashboardPath, resultsPath, eventsPath, metricsPath, safetyReportPath, providerAuditPath]);
  const hasSummary = await existsFile(summaryPath);
  const hasViewer = await existsPath(viewerPath);
  const providerRejected = entry.outcome === "provider_rejected" || entry.providerStatus === "rejected" || safetyFlags.includes("provider_rejected");
  const verificationFailed = entry.outcome === "verification_failed" || safetyFlags.includes("verification_failed") || entry.notes.includes("validation=failed");
  const setupFailure = setupStatus.includes("failed") || entry.outcome.includes("setup_failed");
  const doNotApply = entry.decision === "do_not_apply" || entry.outcome === "do_not_apply" || safetyFlags.includes("do_not_apply");
  return {
    id: stableRunId(entry),
    alpha: entry.milestone,
    repo: shortRepo(entry.repo),
    repoPath: entry.repo,
    scenario: entry.scenario,
    packetType: entry.packetType,
    outcome: entry.outcome,
    providerStatus: entry.providerStatus,
    operatorVerdict: entry.decision,
    mutationVerdict: entry.externalRepoMutationVerdict,
    setupStatus,
    proposalStatus,
    safetyFlags,
    createdAt: updatedAt,
    updatedAt,
    packetPath: entry.packetPath,
    resultsPath,
    viewerPath,
    summaryPath,
    dashboardPath,
    eventsPath,
    metricsPath,
    safetyReportPath,
    providerAuditPath,
    artifactCount,
    commandCount: commandCountFor(entry),
    doNotApply,
    providerRejected,
    verificationFailed,
    verifiedProposal: entry.outcome === "proposal_ready_verified" || proposalStatus === "proposal_ready_verified" || proposalStatus === "verified",
    hasProposal: proposalStatus !== "missing" && proposalStatus !== "unknown",
    setupFailure,
    hasViewer,
    hasSummary,
    urgent: doNotApply || providerRejected || verificationFailed || setupFailure || unsafeMutation(entry.externalRepoMutationVerdict) || missingEvidence(hasSummary, hasViewer, entry.packetPath)
  };
}

function summaryForPacket(packetPath: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return join(packetPath, "..", "summary.md");
}

function resultsForPacket(packetPath: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return join(packetPath, "..", "..", "results.json");
}

function dashboardForPacket(packetPath: string): string {
  if (!packetPath || packetPath === "unknown") return "unknown";
  return runSibling(packetPath, "dashboard/index.html");
}

function proposalStatusFor(entry: PacketIndexEntry): string {
  if (entry.outcome === "proposal_ready_verified") return "proposal_ready_verified";
  if (entry.outcome.includes("proposal")) return entry.outcome;
  if (entry.patchTouchedFiles.length > 0) return entry.decision === "do_not_apply" ? "proposal_blocked" : "proposal_present";
  if (entry.decision && entry.decision !== "unknown") return entry.decision;
  return "missing";
}

function setupStatusFor(entry: PacketIndexEntry): string {
  if (entry.outcome === "setup_failed_main_failed") return "setup_failed_main_failed";
  if (entry.outcome.includes("setup_failed")) return "setup_failed";
  if (entry.notes.includes("diagnostic-continue")) return "setup_failed_diagnostic_continue";
  if (entry.notes.includes("setup-gates-main")) return "setup_gates_main";
  if (entry.notes.includes("setupNetworkIntent")) return "setup_policy_present";
  return "unknown";
}

function safetyFlagsFor(entry: PacketIndexEntry, setupStatus: string, proposalStatus: string): string[] {
  const flags = new Set<string>();
  if (entry.decision === "do_not_apply" || entry.outcome === "do_not_apply") flags.add("do_not_apply");
  if (entry.outcome === "provider_rejected" || entry.providerStatus === "rejected") flags.add("provider_rejected");
  if (entry.outcome === "verification_failed" || entry.notes.includes("validation=failed")) flags.add("verification_failed");
  if (setupStatus.includes("failed")) flags.add(setupStatus);
  if (unsafeMutation(entry.externalRepoMutationVerdict)) flags.add("unsafe_mutation");
  if (proposalStatus === "proposal_blocked") flags.add("proposal_blocked");
  if (entry.notes.includes("manualApplyRequired=true")) flags.add("manual_apply_required");
  return [...flags];
}

function commandCountFor(entry: PacketIndexEntry): number {
  if (entry.packetType.includes("command")) return Math.max(1, entry.patchTouchedFiles.length);
  return 0;
}

async function newestMtime(paths: string[]): Promise<string> {
  let newest = 0;
  for (const path of paths) {
    if (!path || path === "unknown") continue;
    try {
      const info = await stat(path);
      newest = Math.max(newest, info.mtimeMs);
    } catch {
      // Optional artifacts are expected to be missing for older packets.
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : "unknown";
}

async function countExisting(paths: string[]): Promise<number> {
  let count = 0;
  for (const path of paths) {
    if (await existsPath(path)) count += 1;
  }
  return count;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function existsPath(path: string): Promise<boolean> {
  if (!path || path === "unknown") return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stableRunId(entry: PacketIndexEntry): string {
  return Buffer.from(`${entry.milestone}\0${entry.scenario}\0${entry.packetPath}`).toString("base64url");
}

function shortRepo(repo: string): string {
  if (!repo || repo === "unknown") return "unknown";
  return basename(repo) || repo;
}
