import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { exportOkfBundle, validateOkfBundle } from "./okf-knowledge-export.js";
import { findSecretLikeContent } from "./okf-secret-scan.js";
import { buildSkillCuratorReport } from "./skill-curator-report.js";
import { buildSkillInventory } from "./skill-inventory.js";
import { lifecycleStatuses, type LifecycleStatus } from "./lifecycle-status.js";
import { buildHandoffArchive, type HandoffArchiveCounts } from "./external-operator-handoff-archive.js";
import { countHandoffPackets, type HandoffPacketCounts } from "./knowledge-lifecycle-handoff-counts.js";

export interface KnowledgeLifecycleOptions {
  repoRoot: string;
  runs: string;
  out: string;
  skillRoots?: string[];
}

export interface LifecycleItem {
  id: string;
  kind: "okf" | "skill" | "evidence";
  title: string;
  status: LifecycleStatus;
  path: string;
  evidenceLinks: string[];
  findings: string[];
}

export interface KnowledgeLifecycleReport {
  generatedAt: string;
  repoRoot: string;
  sources: { runs: string; okfBundle: string; skillsInventory: string; curatorReport: string };
  sourceCounts: { okfFiles: number; skills: number; validationRuns: number; evidenceFiles: number };
  okfEntryCounts: Record<LifecycleStatus, number>;
  skillsCounts: Record<LifecycleStatus, number>;
  lifecycleStatusCounts: Record<LifecycleStatus, number>;
  findings: string[];
  recommendations: string[];
  milestoneComparison: string[];
  evidenceLinks: string[];
  validation: { ok: boolean; errors: string[] };
  safetySummary: { secretLikeFindings: number; unsafeItems: number; networkRequired: false; providerCalls: false };
  operatorTrialCounts: { accepted: number; rejected: number; missingDecision: number; unsafeMutation: number };
  handoffPacketCounts: HandoffPacketCounts;
  handoffArchiveCounts: HandoffArchiveCounts;
  handoffArchiveRecommendations: string[];
  items: LifecycleItem[];
}

export async function buildKnowledgeLifecycleReport(options: KnowledgeLifecycleOptions): Promise<KnowledgeLifecycleReport> {
  const repoRoot = resolve(options.repoRoot);
  const runs = resolve(repoRoot, options.runs);
  const out = resolve(repoRoot, options.out);
  const work = join(out, "generated");
  await mkdir(work, { recursive: true });

  const okf = await exportOkfBundle({ root: runs, out: join(work, "okf") });
  const okfValidation = await validateOkfBundle(okf.out);
  const inventory = await buildSkillInventory({ out: join(work, "skills"), roots: options.skillRoots });
  const curator = await buildSkillCuratorReport({ runs, out: join(work, "curator") });
  const validationRuns = await collectRunDirs(runs);
  const evidenceFiles = await collectEvidenceFiles(runs);

  const okfItems = await okfLifecycleItems(okf.out, okf.files, repoRoot);
  const skillItems = inventory.skills.map((skill) => ({
    id: `skill:${skill.name}`,
    kind: "skill" as const,
    title: skill.name,
    status: skillStatus(skill.status, skill.notes),
    path: rel(repoRoot, skill.path),
    evidenceLinks: skill.notes.filter((note) => note.includes("Evidence:")).map((note) => note.replace(/^Evidence:\s*/, "")),
    findings: skill.notes
  }));
  const evidenceItems = validationRuns.map((run) => evidenceItem(repoRoot, runs, run));
  const items = [...okfItems, ...skillItems, ...evidenceItems];
  const statusCounts = countStatuses(items);
  const okfEntryCounts = countStatuses(okfItems);
  const skillsCounts = countStatuses(skillItems);
  const findings = reportFindings(items, okfValidation.errors);
  const operatorTrialCounts = await countOperatorTrials(validationRuns.map((run) => join(runs, run, "results.json")));
  const handoffPacketCounts = await countHandoffPackets(validationRuns.map((run) => join(runs, run)));
  const handoffArchive = await buildHandoffArchive({ root: runs });
  const report: KnowledgeLifecycleReport = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    sources: {
      runs: rel(repoRoot, runs),
      okfBundle: rel(repoRoot, okf.out),
      skillsInventory: rel(repoRoot, inventory.jsonPath),
      curatorReport: rel(repoRoot, curator.jsonPath)
    },
    sourceCounts: { okfFiles: okf.files.length, skills: inventory.skills.length, validationRuns: validationRuns.length, evidenceFiles: evidenceFiles.length },
    okfEntryCounts,
    skillsCounts,
    lifecycleStatusCounts: statusCounts,
    findings,
    recommendations: recommendations(statusCounts, okfValidation.ok),
    milestoneComparison: milestoneComparison(validationRuns),
    evidenceLinks: evidenceFiles.slice(0, 40).map((file) => rel(repoRoot, file)),
    validation: { ok: okfValidation.ok && statusCounts.unsafe === 0, errors: okfValidation.errors },
    safetySummary: { secretLikeFindings: statusCounts.unsafe, unsafeItems: statusCounts.unsafe, networkRequired: false, providerCalls: false },
    operatorTrialCounts,
    handoffPacketCounts,
    handoffArchiveCounts: handoffArchive.counts,
    handoffArchiveRecommendations: handoffArchive.recommendations,
    items
  };
  await writeFile(join(out, "lifecycle-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(out, "summary.md"), renderLifecycleSummary(report), "utf8");
  return report;
}

export function renderLifecycleSummary(report: KnowledgeLifecycleReport): string {
  return [
    "# RunForge Alpha-20 Knowledge Lifecycle",
    "",
    `Generated at: ${report.generatedAt}`,
    `Repo root: ${report.repoRoot}`,
    "",
    "## Source Counts",
    "",
    `OKF files: ${report.sourceCounts.okfFiles}`,
    `Skills: ${report.sourceCounts.skills}`,
    `Validation runs: ${report.sourceCounts.validationRuns}`,
    `Evidence files: ${report.sourceCounts.evidenceFiles}`,
    "",
    "## Lifecycle Status Counts",
    "",
    ...lifecycleStatuses.map((status) => `- ${status}: ${report.lifecycleStatusCounts[status]}`),
    "",
    "## Findings",
    "",
    ...(report.findings.length > 0 ? report.findings.map((item) => `- ${item}`) : ["- No blocking lifecycle findings."]),
    "",
    "## Recommendations",
    "",
    ...report.recommendations.map((item) => `- ${item}`),
    "",
    "## Operator Trials",
    "",
    `- accepted: ${report.operatorTrialCounts.accepted}`,
    `- rejected: ${report.operatorTrialCounts.rejected}`,
    `- missing decision: ${report.operatorTrialCounts.missingDecision}`,
    `- unsafe mutation: ${report.operatorTrialCounts.unsafeMutation}`,
    "",
    "## Operator Handoff Packets",
    "",
    `- generated: ${report.handoffPacketCounts.generated}`,
    `- missing README: ${report.handoffPacketCounts.missingReadme}`,
    `- unsafe: ${report.handoffPacketCounts.unsafe}`,
    `- audited: ${report.handoffPacketCounts.audited}`,
    `- audit passed/failed: ${report.handoffPacketCounts.auditPassed}/${report.handoffPacketCounts.auditFailed}`,
    `- unsafe handoff rejected: ${report.handoffPacketCounts.unsafeRejected}`,
    "",
    "## Operator Handoff Archive",
    "",
    `- archived handoffs: ${report.handoffArchiveCounts.records}`,
    `- audited handoffs: ${sumCounts(report.handoffArchiveCounts.byAuditStatus, ["passed", "failed"])}`,
    `- accepted handoffs: ${report.handoffArchiveCounts.byDecision.accepted ?? 0}`,
    `- rejected handoffs: ${report.handoffArchiveCounts.byDecision.rejected ?? 0}`,
    `- unsafe rejected handoffs: ${report.handoffArchiveCounts.bySafetyStatus.unsafe ?? 0}`,
    `- missing audit handoffs: ${report.handoffArchiveCounts.byAuditStatus.missing ?? 0}`,
    "",
    "## Archive Recommendations",
    "",
    ...report.handoffArchiveRecommendations.slice(0, 8).map((item) => `- ${item}`),
    "",
    "## Alpha Comparison",
    "",
    ...report.milestoneComparison.map((item) => `- ${item}`),
    "",
    "## Evidence Links",
    "",
    ...report.evidenceLinks.slice(0, 12).map((item) => `- ${item}`),
    "",
    `Final verdict: ${report.validation.ok ? "passed" : "failed"}`
  ].join("\n") + "\n";
}

async function okfLifecycleItems(okfRoot: string, files: string[], repoRoot: string): Promise<LifecycleItem[]> {
  const seen = new Map<string, number>();
  return Promise.all(files.map(async (file): Promise<LifecycleItem> => {
    const path = join(okfRoot, file);
    const content = await readFile(path, "utf8");
    const id = `okf:${file.replace(/\.md$/, "")}`;
    const links = localLinks(content);
    const findings = itemFindings(content, links);
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const status = itemStatus(content, links, findings, file);
    return { id, kind: "okf", title: title(content) || basename(file), status, path: rel(repoRoot, path), evidenceLinks: links, findings };
  })).then((items) => items.map((item): LifecycleItem => seen.get(item.id)! > 1 ? { ...item, status: "duplicate", findings: [...item.findings, "duplicate OKF id"] } : item));
}

function evidenceItem(repoRoot: string, runs: string, run: string): LifecycleItem {
  const summary = join(runs, run, "summary.md");
  const results = join(runs, run, "results.json");
  return {
    id: `evidence:${run}`,
    kind: "evidence",
    title: run,
    status: /^ALPHA-(?:17|19|20|21|22|23|24|25|26)$/.test(run) || run === "PACKET-VALIDATION" ? "active" : "candidate",
    path: rel(repoRoot, join(runs, run)),
    evidenceLinks: [summary, results].map((file) => rel(repoRoot, file)),
    findings: []
  };
}

function itemStatus(content: string, links: string[], findings: string[], file: string): LifecycleStatus {
  if (findings.some((finding) => finding.includes("secret-like"))) return "unsafe";
  if (findings.some((finding) => finding.includes("missing evidence"))) return "missing_evidence";
  if (/\bretired\b/i.test(content)) return "retired";
  if (/\bALPHA-(?:[1-9]|1[0-6])\b/.test(content) && !/ALPHA-(?:17|18|19|20|21|22|23|24|25|26)|PACKET-VALIDATION/.test(content)) return "stale";
  if (file.includes("skill-candidates/")) return "candidate";
  return links.length > 0 ? "active" : "needs_review";
}

function itemFindings(content: string, links: string[]): string[] {
  const findings = findSecretLikeContent(content).map((pattern) => `secret-like pattern ${pattern}`);
  if (!/Source Evidence|Evidence References|Evidence:/i.test(content)) findings.push("missing evidence section");
  if (links.some((link) => /^(?:https?:|git@)/.test(link))) findings.push("non-local evidence link");
  return findings;
}

function skillStatus(status: string, notes: string[]): LifecycleStatus {
  if (notes.some((note) => /secret-like|forbidden/i.test(note))) return "unsafe";
  if (status === "duplicate_candidate") return "duplicate";
  if (notes.some((note) => /No SKILL\.md|missing evidence/i.test(note))) return "missing_evidence";
  if (status === "stale_candidate") return "stale";
  return status === "active" ? "active" : "needs_review";
}

async function collectRunDirs(runs: string): Promise<string[]> {
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function collectEvidenceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(root, entry.name);
    if (entry.isDirectory()) return collectEvidenceFiles(child);
    if (!entry.isFile()) return [];
    return ["summary.md", "results.json", "operator-decisions.md", "score.json"].includes(entry.name) ? [child] : [];
  }));
  return nested.flat();
}

function countStatuses(items: LifecycleItem[]): Record<LifecycleStatus, number> {
  const counts = Object.fromEntries(lifecycleStatuses.map((status) => [status, 0])) as Record<LifecycleStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function reportFindings(items: LifecycleItem[], validationErrors: string[]): string[] {
  const counts = countStatuses(items);
  return [
    ...validationErrors.map((error) => `OKF validation: ${error}`),
    ...(counts.missing_evidence > 0 ? [`${counts.missing_evidence} lifecycle items need evidence links.`] : []),
    ...(counts.stale > 0 ? [`${counts.stale} lifecycle items reference older milestones and should be reviewed.`] : []),
    ...(counts.unsafe > 0 ? [`${counts.unsafe} lifecycle items contain unsafe or secret-like content.`] : [])
  ];
}
function recommendations(counts: Record<LifecycleStatus, number>, okfValid: boolean): string[] {
  const items = ["Keep packets and dashboard/index records as runtime truth; use OKF as portable memory."];
  if (counts.candidate > 0) items.push("Review candidate knowledge and skills before promotion.");
  if (counts.missing_evidence > 0) items.push("Add or repair local packet/validation evidence links.");
  if (!okfValid || counts.unsafe > 0) items.push("Block promotion until validation and safety findings are cleared.");
  items.push("Next milestone: replay and audit existing operator handoff packets in disposable worktrees.");
  return items;
}

function milestoneComparison(runs: string[]): string[] {
  const has = (run: string) => runs.includes(run);
  return [
    has("ALPHA-17") ? "Alpha-17 established OKF export, OKF validation, skills inventory, and curator reports." : "Alpha-17 run evidence is not present as validation/runs/ALPHA-17; Alpha-17 OKF and skills artifacts are covered through generated export, validation, inventory, and curator outputs.",
    has("ALPHA-19") ? "Alpha-19 added setup policy acceptance evidence across packets, dashboard data, and multi-repo validation." : "Alpha-19 evidence is absent locally.",
    "Alpha-20 connects those artifacts into a lifecycle report with deterministic status counts, findings, recommendations, and safety summary.",
    has("ALPHA-21") ? "Alpha-21 records a manual operator accepted-patch trial with validation rerun evidence and no RunForge auto-apply." : "Alpha-21 evidence is absent locally.",
    has("ALPHA-22") ? "Alpha-22 extends the operator loop to a real external repo disposable copy and records accepted and rejected operator decisions separately." : "Alpha-22 evidence is absent locally.",
    has("ALPHA-23") ? "Alpha-23 hardens operator patch trial UX with decision summaries, safety lint, and accepted/rejected visibility." : "Alpha-23 evidence is absent locally.",
    has("ALPHA-24") ? "Alpha-24 generates a portable real-operator handoff packet with manual apply, validation, rollback, decisions, and evidence links." : "Alpha-24 evidence is absent locally.",
    has("ALPHA-25") ? "Alpha-25 replays and audits operator handoff packets in disposable worktrees, including unsafe-packet rejection evidence." : "Alpha-25 evidence is absent locally.",
    has("ALPHA-26") ? "Alpha-26 archives and searches handoff/audit evidence with lifecycle recommendations." : "Alpha-26 evidence is absent locally."
  ];
}
function localLinks(content: string): string[] {
  const markdownLinks = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  const codePaths = [...content.matchAll(/`([^`]*(?:validation\/runs|summary\.md|results\.json|packet)[^`]*)`/g)].map((match) => match[1]);
  return [...new Set([...markdownLinks, ...codePaths])].filter((link) => !link.startsWith("#"));
}
function title(content: string): string | undefined {
  return content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}
function rel(root: string, path: string): string {
  return relative(root, resolve(path)) || ".";
}

async function countOperatorTrials(resultPaths: string[]): Promise<{ accepted: number; rejected: number; missingDecision: number; unsafeMutation: number }> {
  const counts = { accepted: 0, rejected: 0, missingDecision: 0, unsafeMutation: 0 };
  for (const path of resultPaths) {
    let raw: { attempts?: Array<{ decision?: string; operatorDecision?: string; originalRepoMutated?: boolean }> };
    try {
      raw = JSON.parse(await readFile(path, "utf8")) as typeof raw;
    } catch {
      continue;
    }
    for (const attempt of raw.attempts ?? []) {
      const decision = attempt.operatorDecision ?? attempt.decision ?? "";
      if (decision === "accepted") counts.accepted += 1;
      else if (decision === "rejected") counts.rejected += 1;
      else counts.missingDecision += 1;
      if (attempt.originalRepoMutated === true) counts.unsafeMutation += 1;
    }
  }
  return counts;
}

function sumCounts(counts: Record<string, number>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}
