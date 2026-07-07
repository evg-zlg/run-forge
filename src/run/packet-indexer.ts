import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { renderPacketIndexMarkdown } from "./packet-index-renderer.js";

export { renderPacketIndexMarkdown, renderPacketIndexText } from "./packet-index-renderer.js";

export interface PacketIndexOptions { root: string; out?: string; }

export interface PacketIndexEntry {
  milestone: string;
  scenario: string;
  packetType: string;
  outcome: string;
  providerStatus: string;
  repo: string;
  patchTouchedFiles: string[];
  packetPath: string;
  viewerPath: string;
  externalRepoHeadBefore: string | null;
  externalRepoHeadAfter: string | null;
  externalRepoMutationVerdict: string;
  decision: string;
  decisionAppliedTo: string;
  autoAppliedByRunForge: boolean | null;
  validationBefore: string;
  validationAfter: string;
  proposalPatchPath: string;
  handoffReadmePath: string;
  handoffJsonPath: string;
  handoffAuditStatus: string;
  handoffAuditReportPath: string;
  handoffAuditResultPath: string;
  originalRepoMutated: boolean | null;
  notes: string;
}

export interface PacketIndexResult { schemaVersion: "packet-index-v1"; generatedAt: string; root: string; entries: PacketIndexEntry[]; }

interface DogfoodIndexEntry {
  repo?: string;
  scenario?: string;
  outcome?: string;
  providerStatus?: string;
  patchTouchedFiles?: string[];
  packetPath?: string;
  viewerPath?: string;
  externalRepoHeadBefore?: string | null;
  externalRepoHeadAfter?: string | null;
  externalRepoMutationVerdict?: string;
  decision?: string;
  notes?: string;
  decisionAppliedTo?: string;
  autoAppliedByRunForge?: boolean | null;
  validationBefore?: string;
  validationAfter?: string;
  proposalPatchPath?: string;
  handoffReadmePath?: string;
  handoffJsonPath?: string;
  handoffAuditStatus?: string;
  handoffAuditReportPath?: string;
  handoffAuditResultPath?: string;
  originalRepoMutated?: boolean | null;
}

interface ResultsAttempt {
  id?: string;
  repo?: string;
  decision?: string;
  packet?: string;
  viewer?: string;
  outcome?: string;
  providerStatus?: string;
  filesChanged?: string[];
  externalRepoHeadBefore?: string | null;
  externalRepoHeadAfter?: string | null;
  manualApply?: boolean;
  appliedTo?: string;
  originalRepoMutated?: boolean;
  validationBefore?: string;
  validationAfter?: string;
  proposalPatch?: string;
  handoffReadme?: string;
  handoffJson?: string;
  handoffAuditStatus?: string;
  handoffAuditReport?: string;
  handoffAuditResult?: string;
}

interface ResultsJson { externalRepo?: RepoState; originalRepo?: RepoState; attempts?: ResultsAttempt[]; }

interface RepoState { beforeHead?: string | null; afterHead?: string | null; mutationVerdict?: string; }

interface RunJson {
  taskType?: string;
  status?: string;
  setupPolicy?: { networkIntent?: string; continueAfterSetupFailure?: boolean; mainCommandsSkippedOnSetupFailure?: boolean };
  repo?: { path?: string; mutationVerdict?: string; headBefore?: string | null; headAfter?: string | null } | null;
}

interface ProposalStatus { outcome?: string; providerStatus?: string; filesChanged?: string[]; reviewerDecision?: string; diagnostics?: string[]; }

interface OperatorDecisionRecord {
  decision?: string;
  finalOutcome?: string;
  validation?: { status?: string; passed?: boolean; packet?: string };
  apply?: { appliedTo?: string; originalRepoMutated?: boolean };
  runforgeAppliedPatch?: boolean;
  manualApplyRequired?: boolean;
  proposalPatch?: string;
}

interface OperatorHandoffLink { readmePath?: string; handoffJsonPath?: string; }

export async function buildPacketIndex(options: PacketIndexOptions): Promise<PacketIndexResult> {
  const root = resolve(options.root);
  const entries = dedupeEntries([
    ...(await entriesFromDogfoodIndexes(root)),
    ...(await entriesFromResults(root)),
    ...(await entriesFromPackets(root))
  ]);
  const result: PacketIndexResult = {
    schemaVersion: "packet-index-v1",
    generatedAt: new Date().toISOString(),
    root,
    entries: entries.sort((a, b) => `${a.milestone}/${a.scenario}/${a.packetPath}`.localeCompare(`${b.milestone}/${b.scenario}/${b.packetPath}`))
  };

  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "index.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(out, "index.md"), renderPacketIndexMarkdown(result), "utf8");
  }

  return result;
}

async function entriesFromDogfoodIndexes(root: string): Promise<PacketIndexEntry[]> {
  const paths = await findFiles(root, "external-dogfood-index.json");
  const entries: PacketIndexEntry[] = [];
  for (const path of paths) {
    const milestone = basename(dirname(path));
    const raw = await readJson<DogfoodIndexEntry[] | { entries?: DogfoodIndexEntry[] }>(path);
    const items = Array.isArray(raw) ? raw : raw.entries ?? [];
    for (const item of items) {
      entries.push(normalizeEntry(milestone, item.scenario ?? "unknown", {
        repo: item.repo,
        outcome: item.outcome,
        providerStatus: item.providerStatus,
        patchTouchedFiles: item.patchTouchedFiles,
        packetPath: item.packetPath,
        viewerPath: item.viewerPath,
        externalRepoHeadBefore: item.externalRepoHeadBefore,
        externalRepoHeadAfter: item.externalRepoHeadAfter,
        externalRepoMutationVerdict: item.externalRepoMutationVerdict,
        decision: item.decision,
        notes: item.notes
      }));
    }
  }
  return entries;
}

async function entriesFromResults(root: string): Promise<PacketIndexEntry[]> {
  const paths = await findFiles(root, "results.json");
  const entries: PacketIndexEntry[] = [];
  for (const path of paths) {
    const milestone = basename(dirname(path));
    const result = await readJson<ResultsJson>(path);
    const repoState = result.externalRepo ?? result.originalRepo;
    for (const attempt of result.attempts ?? []) {
      entries.push(normalizeEntry(milestone, attempt.id ?? "unknown", {
        repo: attempt.repo,
        outcome: attempt.outcome,
        providerStatus: attempt.providerStatus,
        patchTouchedFiles: attempt.filesChanged,
        packetPath: attempt.packet,
        viewerPath: attempt.viewer,
        externalRepoHeadBefore: attempt.externalRepoHeadBefore ?? repoState?.beforeHead,
        externalRepoHeadAfter: attempt.externalRepoHeadAfter ?? repoState?.afterHead,
        externalRepoMutationVerdict: repoState?.mutationVerdict,
        decision: attempt.decision ?? (attempt.manualApply === false ? "no_apply" : undefined),
        decisionAppliedTo: attempt.appliedTo,
        autoAppliedByRunForge: attempt.manualApply === true ? false : null,
        validationBefore: attempt.validationBefore,
        validationAfter: attempt.validationAfter,
        proposalPatchPath: attempt.proposalPatch,
        handoffReadmePath: attempt.handoffReadme,
        handoffJsonPath: attempt.handoffJson,
        handoffAuditStatus: attempt.handoffAuditStatus,
        handoffAuditReportPath: attempt.handoffAuditReport,
        handoffAuditResultPath: attempt.handoffAuditResult,
        originalRepoMutated: attempt.originalRepoMutated,
        notes: attempt.manualApply === false ? "Patch was not manually applied to the external repo." : undefined
      }));
    }
  }
  return entries;
}

async function entriesFromPackets(root: string): Promise<PacketIndexEntry[]> {
  const paths = await findFiles(root, "run.json");
  const entries: PacketIndexEntry[] = [];
  for (const runPath of paths) {
    const packetPath = dirname(runPath);
    const run = await readJson<RunJson>(runPath);
    const status = await readOptionalJson<ProposalStatus>(join(packetPath, "proposal-status.json"));
    const operatorDecision = await readOptionalJson<OperatorDecisionRecord>(join(packetPath, "operator-decision.json"));
    const handoff = await readOptionalJson<OperatorHandoffLink>(join(packetPath, "operator-handoff.json"));
    entries.push(normalizeEntry(milestoneFor(root, packetPath), scenarioFor(root, packetPath), {
      repo: run.repo?.path,
      outcome: status?.outcome ?? run.status,
      providerStatus: status?.providerStatus,
      patchTouchedFiles: status?.filesChanged,
      packetPath,
      viewerPath: viewerForPacket(packetPath),
      externalRepoHeadBefore: run.repo?.headBefore,
      externalRepoHeadAfter: run.repo?.headAfter,
      externalRepoMutationVerdict: run.repo?.mutationVerdict,
      decision: operatorDecision?.finalOutcome ?? status?.reviewerDecision,
      decisionAppliedTo: operatorDecision?.apply?.appliedTo,
      autoAppliedByRunForge: operatorDecision?.runforgeAppliedPatch ?? null,
      validationAfter: operatorDecision ? (operatorDecision.validation?.passed ? "passed" : operatorDecision.validation?.status ?? "unknown") : undefined,
      proposalPatchPath: operatorDecision?.proposalPatch,
      handoffReadmePath: handoff?.readmePath,
      handoffJsonPath: handoff?.handoffJsonPath,
      originalRepoMutated: operatorDecision?.apply?.originalRepoMutated ?? null,
      notes: [status?.diagnostics?.join("; "), setupPolicyNote(run), operatorDecisionNote(operatorDecision)].filter(Boolean).join("; "),
      packetType: run.taskType?.replace(/^external_/, "")
    }));
  }
  return entries;
}

function setupPolicyNote(run: RunJson): string {
  if (!run.setupPolicy) return "";
  const diagnostic = run.setupPolicy.continueAfterSetupFailure ? "diagnostic-continue" : "setup-gates-main";
  return `setupNetworkIntent=${run.setupPolicy.networkIntent ?? "unknown"} ${diagnostic}`;
}

function operatorDecisionNote(record: OperatorDecisionRecord | null): string {
  if (!record) return "";
  return [
    `operatorDecision=${record.decision ?? "unknown"}`,
    `finalOutcome=${record.finalOutcome ?? "unknown"}`,
    `validation=${record.validation?.passed ? "passed" : record.validation?.status ?? "unknown"}`,
    `runforgeAppliedPatch=${record.runforgeAppliedPatch === true ? "true" : "false"}`,
    `manualApplyRequired=${record.manualApplyRequired === false ? "false" : "true"}`
  ].join(" ");
}

function normalizeEntry(milestone: string, scenario: string, input: Partial<PacketIndexEntry>): PacketIndexEntry {
  return {
    milestone,
    scenario,
    packetType: input.packetType ?? "external_code_proposal",
    outcome: input.outcome ?? "unknown",
    providerStatus: input.providerStatus ?? "unknown",
    repo: input.repo ?? "unknown",
    patchTouchedFiles: input.patchTouchedFiles ?? [],
    packetPath: input.packetPath ?? "unknown",
    viewerPath: input.viewerPath ?? "unknown",
    externalRepoHeadBefore: input.externalRepoHeadBefore ?? null,
    externalRepoHeadAfter: input.externalRepoHeadAfter ?? null,
    externalRepoMutationVerdict: input.externalRepoMutationVerdict ?? "unknown",
    decision: input.decision ?? "unknown",
    decisionAppliedTo: input.decisionAppliedTo ?? "unknown",
    autoAppliedByRunForge: input.autoAppliedByRunForge ?? null,
    validationBefore: input.validationBefore ?? "unknown",
    validationAfter: input.validationAfter ?? "unknown",
    proposalPatchPath: input.proposalPatchPath ?? "unknown",
    handoffReadmePath: input.handoffReadmePath ?? "unknown",
    handoffJsonPath: input.handoffJsonPath ?? "unknown",
    handoffAuditStatus: input.handoffAuditStatus ?? "unknown",
    handoffAuditReportPath: input.handoffAuditReportPath ?? "unknown",
    handoffAuditResultPath: input.handoffAuditResultPath ?? "unknown",
    originalRepoMutated: input.originalRepoMutated ?? null,
    notes: input.notes ?? ""
  };
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, async (path) => {
    if (basename(path) === fileName) found.push(path);
  });
  return found;
}

async function walk(path: string, visit: (path: string) => Promise<void>): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    await visit(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await walk(join(path, entry), visit);
  }
}

function milestoneFor(root: string, packetPath: string): string {
  const [first] = relative(root, packetPath).split("/");
  return first || "unknown";
}

function scenarioFor(root: string, packetPath: string): string {
  const parts = relative(root, packetPath).split("/");
  const packetIndex = parts.lastIndexOf("packet");
  if (packetIndex > 0) return parts[packetIndex - 1]!;
  return parts.at(-2) ?? parts.at(-1) ?? "unknown";
}

function viewerForPacket(packetPath: string): string {
  if (basename(packetPath) === "packet") return join(dirname(packetPath), "viewer", "index.html");
  return "unknown";
}

function dedupeEntries(entries: PacketIndexEntry[]): PacketIndexEntry[] {
  const byKey = new Map<string, PacketIndexEntry>();
  for (const entry of entries) {
    const key = `${entry.milestone}\0${entry.scenario}\0${entry.packetPath}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}
