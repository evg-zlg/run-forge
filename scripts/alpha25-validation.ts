import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";
import { replayOperatorHandoffPacket } from "../src/run/external-operator-handoff-replay.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const externalRepo = "/Users/evgeny/Documents/projects/factory";
const trialRoot = "/tmp/runforge-alpha25-handoff-replay/factory";
const validationDir = join(repo, "validation/runs/ALPHA-25");
const handoffDir = join(trialRoot, "handoff");
const auditDir = join(trialRoot, "audit");
const unsafeHandoffDir = join(trialRoot, "unsafe-handoff");
const unsafeAuditDir = join(trialRoot, "unsafe-audit");
const validationCommand = "node runforge-alpha22-verify.cjs";
const errors: string[] = [];
const commandsRun: string[] = [];

await rm(trialRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });

const originalBefore = await gitSnapshot(externalRepo);

await runCli([
  "external", "patch-trial",
  "--repo", externalRepo,
  "--mode", "real-repo-disposable",
  "--out", trialRoot,
  "--run-id", "alpha25-handoff-replay"
]);

const sourceRepo = join(trialRoot, "source-copy");
const proposalPacket = join(trialRoot, "proposal-run", "packet");
const proposalPatch = join(proposalPacket, "proposal.patch");

await runCli([
  "external", "handoff-packet",
  "--trial", trialRoot,
  "--out", handoffDir,
  "--operator-worktree", sourceRepo,
  "--validation-command", validationCommand,
  "--trial-id", "alpha25-handoff-replay"
]);

await runCli([
  "external", "handoff-replay",
  "--handoff", handoffDir,
  "--out", auditDir,
  "--audit-id", "alpha25-valid-handoff-replay"
]);

const validAudit = await readJson<{
  status?: string;
  replay?: { patchApplied?: boolean; validationRun?: boolean; validationStatus?: string; worktreePath?: string };
  sourceRepo?: { originalRepoMutated?: boolean; headBefore?: string | null; headAfter?: string | null; statusBefore?: string; statusAfter?: string };
  decisionForms?: { acceptedValid?: boolean; rejectedValid?: boolean };
  safety?: Record<string, boolean>;
  artifacts?: { auditReport?: string; auditResult?: string; replayLog?: string };
}>(join(auditDir, "audit-result.json"));

check(validAudit.status === "passed", "valid handoff replay audit should pass");
check(validAudit.replay?.patchApplied === true, "valid replay should apply patch");
check(validAudit.replay?.validationRun === true && validAudit.replay.validationStatus === "passed", "valid replay validation should pass");
check(validAudit.sourceRepo?.originalRepoMutated === false, "valid replay should not mutate original repo");
check(validAudit.decisionForms?.acceptedValid === true, "accepted decision form should validate");
check(validAudit.decisionForms?.rejectedValid === true, "rejected decision form should validate");

await cp(handoffDir, unsafeHandoffDir, { recursive: true });
await rm(join(unsafeHandoffDir, "README.md"), { force: true });
const unsafeHandoff = await readJson<Record<string, unknown>>(join(unsafeHandoffDir, "handoff.json"));
const proposal = objectValue(unsafeHandoff.proposal);
if (proposal) proposal.autoAppliedByRunForge = true;
const validation = objectValue(unsafeHandoff.validation);
if (validation) validation.command = "git push origin main";
await writeFile(join(unsafeHandoffDir, "handoff.json"), `${JSON.stringify(unsafeHandoff, null, 2)}\n`, "utf8");

const unsafeAudit = await replayOperatorHandoffPacket({
  handoff: unsafeHandoffDir,
  out: unsafeAuditDir,
  auditId: "alpha25-unsafe-handoff-rejected"
});
check(unsafeAudit.status === "failed", "unsafe/incomplete handoff audit should fail");
check(unsafeAudit.safety.unsafeInstructionsFound === true || unsafeAudit.safety.forbiddenTargetsFound === true || unsafeAudit.findings.length > 0, "unsafe handoff audit should record safety findings");
check(unsafeAudit.replay.patchApplied === false, "unsafe handoff should not be replay-applied");

const originalAfter = await gitSnapshot(externalRepo);
const originalMutationVerdict = originalBefore.head === originalAfter.head && originalBefore.status === originalAfter.status ? "unchanged" : "changed";
check(originalMutationVerdict === "unchanged", "original external repo HEAD/status should remain unchanged");

await cp(join(auditDir, "audit-report.md"), join(validationDir, "audit-report.md"));
await cp(join(auditDir, "audit-result.json"), join(validationDir, "audit-result.json"));
await mkdir(join(validationDir, "unsafe"), { recursive: true });
await cp(join(unsafeAuditDir, "audit-report.md"), join(validationDir, "unsafe", "audit-report.md"));
await cp(join(unsafeAuditDir, "audit-result.json"), join(validationDir, "unsafe", "audit-result.json"));

const preliminaryResults = {
  schemaVersion: "alpha-25-handoff-replay-audit",
  generatedAt: new Date().toISOString(),
  sourceHandoffPath: handoffDir,
  originalRepo: {
    path: externalRepo,
    beforeHead: originalBefore.head,
    beforeStatus: originalBefore.status,
    afterHead: originalAfter.head,
    afterStatus: originalAfter.status,
    mutationVerdict: originalMutationVerdict
  },
  replay: {
    worktreePath: validAudit.replay?.worktreePath,
    auditDir,
    auditReport: join(auditDir, "audit-report.md"),
    auditResult: join(auditDir, "audit-result.json"),
    status: validAudit.status,
    patchApplied: validAudit.replay?.patchApplied,
    validationStatus: validAudit.replay?.validationStatus
  },
  unsafeReplay: {
    handoffDir: unsafeHandoffDir,
    auditDir: unsafeAuditDir,
    status: unsafeAudit.status,
    findings: unsafeAudit.findings
  },
  attempts: [{
    id: "factory-handoff-replay-audit",
    repo: externalRepo,
    decision: "handoff_audit_passed",
    packet: proposalPacket,
    viewer: "unknown",
    outcome: "handoff_replay_audit_passed",
    providerStatus: "disabled",
    filesChanged: ["runforge-alpha22/math.cjs"],
    manualApply: false,
    appliedTo: "disposable_replay_worktree",
    originalRepoMutated: false,
    validationBefore: "failed",
    validationAfter: validAudit.replay?.validationStatus,
    proposalPatch,
    handoffReadme: join(handoffDir, "README.md"),
    handoffJson: join(handoffDir, "handoff.json"),
    handoffAuditStatus: validAudit.status,
    handoffAuditReport: join(auditDir, "audit-report.md"),
    handoffAuditResult: join(auditDir, "audit-result.json")
  }],
  decisionForms: validAudit.decisionForms,
  safety: {
    validAuditSafety: validAudit.safety,
    unsafeAuditRejected: unsafeAudit.status === "failed",
    noOriginalExternalRepoMutation: originalMutationVerdict === "unchanged",
    noAutoApplyToOriginalRepo: true,
    replayOnlyUnderTmp: String(validAudit.replay?.worktreePath ?? "").startsWith("/tmp/"),
    noProviderCalls: true,
    noNetworkRequired: true,
    noDbAccess: true,
    noPushMergeDeploy: true
  },
  visibility: {
    packetIndex: join(trialRoot, "index", "index.json"),
    dashboard: join(trialRoot, "dashboard", "dashboard-data.json"),
    lifecycleReport: "validation/runs/ALPHA-25/lifecycle-report.json"
  },
  limitations: [
    "Replay audits apply patches only in disposable replay worktrees under /tmp.",
    "Validation command safety is deterministic lint plus local execution; no network sandbox is introduced.",
    "The real repo source was Factory, but failure injection and replay occur only in disposable copies."
  ],
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(preliminaryResults, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(trialRoot, "index"), "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(trialRoot, "index", "dashboard-seed.json"), "--out", join(trialRoot, "dashboard")]);

const indexMarkdown = await readFile(join(trialRoot, "index", "index.md"), "utf8");
check(indexMarkdown.includes("handoff_replay_audit_passed"), "packet index should expose replay audit outcome");
check(indexMarkdown.includes(join(auditDir, "audit-report.md")), "packet index should expose replay audit report path");
const dashboardData = await readJson<{ records?: Array<{ alpha?: string; handoffAuditStatus?: string; handoffAuditReportPath?: string; originalRepoMutated?: boolean | null }> }>(join(trialRoot, "dashboard", "dashboard-data.json"));
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-25" && record.handoffAuditStatus === "passed" && record.originalRepoMutated === false), "dashboard data should expose replay audit passed and original repo unchanged");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-25",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.handoffPacketCounts.audited >= 2, "lifecycle should count handoff replay audits");
check(lifecycle.handoffPacketCounts.auditPassed >= 1, "lifecycle should count passed handoff replay audit");
check(lifecycle.handoffPacketCounts.auditFailed >= 1, "lifecycle should count failed handoff replay audit");
check(lifecycle.handoffPacketCounts.unsafeRejected >= 1, "lifecycle should count unsafe handoff rejection");
check(lifecycle.milestoneComparison.some((line) => line.includes("Alpha-25")), "lifecycle report should mention Alpha-25");

await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-25-compact-lifecycle-report",
  generatedAt: lifecycle.generatedAt,
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  operatorTrialCounts: lifecycle.operatorTrialCounts,
  handoffPacketCounts: lifecycle.handoffPacketCounts,
  visibility: {
    packetIndexHasAudit: indexMarkdown.includes(join(auditDir, "audit-report.md")),
    dashboardHasAudit: (dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-25" && record.handoffAuditStatus === "passed")
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-25") || line.includes("Alpha-24")),
  findings: lifecycle.findings,
  recommendations: lifecycle.recommendations,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
}, null, 2)}\n`, "utf8");

const finalResults = {
  ...preliminaryResults,
  visibility: {
    ...preliminaryResults.visibility,
    packetIndexAuditVisible: indexMarkdown.includes(join(auditDir, "audit-report.md")),
    dashboardAuditVisible: (dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-25" && record.handoffAuditStatus === "passed"),
    lifecycleCounts: lifecycle.handoffPacketCounts
  },
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(finalResults, null, 2)}\n`, "utf8");
await writeSummary(finalResults);

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Alpha-25 validation passed.");
console.log(`Audit report: ${join(validationDir, "audit-report.md")}`);
console.log(`Audit result: ${join(validationDir, "audit-result.json")}`);
console.log(`Replay worktree: ${validAudit.replay?.worktreePath}`);

async function runCli(args: string[]): Promise<void> {
  const display = `pnpm dev ${args.join(" ")}`;
  commandsRun.push(display);
  const { stdout, stderr } = await execFileAsync("pnpm", ["dev", ...args], { cwd: repo, timeout: 180000 });
  if (stdout.trim()) commandsRun.push(`# stdout: ${stdout.trim().split("\n")[0]}`);
  if (stderr.trim()) commandsRun.push(`# stderr: ${stderr.trim().split("\n")[0]}`);
}

async function gitSnapshot(path: string): Promise<{ head: string | null; status: string }> {
  const head = await runExternal("git", ["rev-parse", "HEAD"], path);
  const status = await runExternal("git", ["status", "--short"], path);
  return { head: head.trim() || null, status: status.trim() };
}

async function runExternal(command: string, args: string[], cwd: string): Promise<string> {
  commandsRun.push(`(cd ${cwd} && ${[command, ...args].join(" ")})`);
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: 120000 });
  return stdout;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function writeSummary(results: typeof finalResults): Promise<void> {
  await writeFile(join(validationDir, "summary.md"), [
    "# Alpha-25 Operator Handoff Replay / Audit",
    "",
    `Final verdict: ${results.finalVerdict}`,
    "",
    "## Source Handoff",
    "",
    `- Handoff path: ${results.sourceHandoffPath}`,
    `- Original repo: ${results.originalRepo.path}`,
    `- Original HEAD before: ${results.originalRepo.beforeHead}`,
    `- Original HEAD after: ${results.originalRepo.afterHead}`,
    `- Original status before: ${results.originalRepo.beforeStatus || "(clean)"}`,
    `- Original status after: ${results.originalRepo.afterStatus || "(clean)"}`,
    `- Original mutation verdict: ${results.originalRepo.mutationVerdict}`,
    "",
    "## Replay Audit",
    "",
    `- Replay worktree: ${results.replay.worktreePath}`,
    `- Valid audit status: ${results.replay.status}`,
    `- Patch applied: ${results.replay.patchApplied}`,
    `- Validation status: ${results.replay.validationStatus}`,
    `- Tracked audit report: validation/runs/ALPHA-25/audit-report.md`,
    `- Tracked audit result: validation/runs/ALPHA-25/audit-result.json`,
    "",
    "## Negative Test",
    "",
    `- Unsafe handoff audit status: ${results.unsafeReplay.status}`,
    `- Unsafe findings: ${results.unsafeReplay.findings.length}`,
    "",
    "## Decision Forms",
    "",
    `- Accepted valid: ${results.decisionForms?.acceptedValid}`,
    `- Rejected valid: ${results.decisionForms?.rejectedValid}`,
    "",
    "## Visibility",
    "",
    `- Packet index audit visible: ${results.visibility.packetIndexAuditVisible}`,
    `- Dashboard audit visible: ${results.visibility.dashboardAuditVisible}`,
    `- Lifecycle report: validation/runs/ALPHA-25/lifecycle-report.json`,
    "",
    "## Safety",
    "",
    "- Replay applies only in a disposable replay worktree.",
    "- Original repo is never modified.",
    "- Replay is an audit/simulation, not production apply.",
    "- No provider, network, DB, deploy, push, or merge is required.",
    "",
    "## Known Limitations",
    "",
    ...results.limitations.map((item) => `- ${item}`),
    "",
    "## Evidence",
    "",
    "- validation/runs/ALPHA-25/results.json",
    "- validation/runs/ALPHA-25/audit-report.md",
    "- validation/runs/ALPHA-25/audit-result.json",
    "- validation/runs/ALPHA-25/lifecycle-report.json",
    ""
  ].join("\n"), "utf8");
}
