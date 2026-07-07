import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildHandoffArchive, searchHandoffArchive, validateHandoffArchiveRecords, type HandoffArchiveRecord } from "../src/run/external-operator-handoff-archive.js";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const tmpRoot = "/tmp/runforge-alpha26-handoff-archive";
const sourceRoot = join(tmpRoot, "source");
const archiveDir = join(tmpRoot, "archive");
const searchDir = join(tmpRoot, "search");
const zeroSearchDir = join(tmpRoot, "search-zero");
const validationDir = join(repo, "validation/runs/ALPHA-26");
const errors: string[] = [];
const commandsRun: string[] = [];

await rm(tmpRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(sourceRoot, { recursive: true });
await mkdir(validationDir, { recursive: true });

const safeHandoffDir = join(sourceRoot, "ALPHA-26-DEMO", "accepted-handoff");
const safeAuditDir = join(sourceRoot, "ALPHA-26-DEMO", "accepted-audit");
const unsafeHandoffDir = join(sourceRoot, "ALPHA-26-DEMO", "unsafe-handoff");
const unsafeAuditDir = join(sourceRoot, "ALPHA-26-DEMO", "unsafe-audit");
await writeHandoffFixture(safeHandoffDir, {
  id: "alpha26-accepted-audited",
  repoPath: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
  validationCommand: "node verify.cjs",
  unsafe: false
});
await writeAuditFixture(safeAuditDir, safeHandoffDir, "passed", "passed", []);
await writeHandoffFixture(unsafeHandoffDir, {
  id: "alpha26-unsafe-rejected",
  repoPath: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
  validationCommand: "git push origin main",
  unsafe: true
});
await writeAuditFixture(unsafeAuditDir, unsafeHandoffDir, "failed", "skipped", ["validation command attempts forbidden push operation", "handoff proposal autoAppliedByRunForge=true"]);
await writeResultsFixture(join(sourceRoot, "ALPHA-26-DEMO", "results.json"), safeHandoffDir, safeAuditDir, unsafeHandoffDir, unsafeAuditDir);

await runCli(["external", "handoff-archive", "--root", sourceRoot, "--out", archiveDir]);
const archivePath = join(archiveDir, "handoff-archive.json");
const archive = await readJson<Awaited<ReturnType<typeof buildHandoffArchive>>>(archivePath);
check(archive.records.length === 2, "archive should discover accepted and unsafe handoff records");
check(archive.counts.byAuditStatus.passed === 1, "archive should count passed audits");
check(archive.counts.byAuditStatus.failed === 1, "archive should count failed audits");
check(archive.counts.bySafetyStatus.unsafe === 1, "archive should count unsafe handoffs");
check(archive.counts.byDecision.accepted === 1, "archive should count accepted handoffs");
check(archive.counts.byDecision.rejected === 1, "archive should count rejected handoffs");
check(archive.validation.passed, `archive validation should pass: ${archive.validation.errors.join("; ")}`);
check(archive.recommendations.some((item) => item.includes("Candidate OKF lesson")), "archive should recommend OKF/skills lessons for accepted passed handoffs");
check(archive.recommendations.some((item) => item.includes("Candidate safety lesson")), "archive should recommend safety lessons for unsafe handoffs");

await runCli(["external", "handoff-search", "--archive", archivePath, "--repo", "factory", "--decision", "accepted", "--audit-status", "passed", "--out", searchDir, "--format", "json"]);
const search = await readJson<Awaited<ReturnType<typeof searchHandoffArchive>>>(join(searchDir, "handoff-search-results.json"));
check(search.matchingCount === 1, "accepted passed search should return one record");
await runCli(["external", "handoff-search", "--archive", archivePath, "--repo", "missing-repo", "--out", zeroSearchDir, "--format", "json"]);
const zeroSearch = await readJson<Awaited<ReturnType<typeof searchHandoffArchive>>>(join(zeroSearchDir, "handoff-search-results.json"));
check(zeroSearch.matchingCount === 0, "zero-result search should return zero records gracefully");
await runCli(["external", "handoff-archive-validate", "--archive", archivePath]);

const malformedValidation = validateHandoffArchiveRecords([malformedRecord()]);
check(!malformedValidation.passed, "malformed archive validation should fail");
check(malformedValidation.errors.some((error: string) => error.includes("original repo mutated true")), "malformed validation should catch original repo mutation");
check(malformedValidation.errors.some((error: string) => error.includes("unsafe status requires reasons")), "malformed validation should catch missing unsafe reasons");
check(malformedValidation.errors.some((error: string) => error.includes("accepted decision requires validationAfter=passed")), "malformed validation should catch accepted failed validation");

await cp(join(archiveDir, "handoff-archive.json"), join(validationDir, "handoff-archive.json"));
await cp(join(archiveDir, "handoff-archive.md"), join(validationDir, "handoff-archive.md"));
await cp(join(searchDir, "handoff-search-results.json"), join(validationDir, "handoff-search-results.json"));

const preliminaryResults = {
  schemaVersion: "alpha-26-handoff-archive-search",
  generatedAt: new Date().toISOString(),
  archiveRootsScanned: [sourceRoot],
  archive: {
    path: archivePath,
    trackedJson: "validation/runs/ALPHA-26/handoff-archive.json",
    trackedMarkdown: "validation/runs/ALPHA-26/handoff-archive.md",
    records: archive.records.length,
    counts: archive.counts,
    validation: archive.validation
  },
  searchExamples: {
    acceptedPassed: {
      command: `pnpm dev external handoff-search --archive ${archivePath} --repo factory --decision accepted --audit-status passed`,
      matchingCount: search.matchingCount,
      ids: search.records.map((record) => record.id)
    },
    zeroResults: {
      command: `pnpm dev external handoff-search --archive ${archivePath} --repo missing-repo`,
      matchingCount: zeroSearch.matchingCount
    }
  },
  negativeValidation: malformedValidation,
  attempts: [{
    id: "alpha26-handoff-archive-search",
    repo: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
    decision: "handoff_archive_generated",
    packet: "unknown",
    viewer: "unknown",
    outcome: "handoff_archive_search_ready",
    providerStatus: "disabled",
    filesChanged: [],
    manualApply: false,
    appliedTo: "read_only_archive",
    originalRepoMutated: false,
    validationBefore: "failed",
    validationAfter: "passed",
    proposalPatch: join(safeHandoffDir, "proposal.patch"),
    handoffReadme: join(safeHandoffDir, "README.md"),
    handoffJson: join(safeHandoffDir, "handoff.json"),
    handoffAuditStatus: "passed",
    handoffAuditReport: join(safeAuditDir, "audit-report.md"),
    handoffAuditResult: join(safeAuditDir, "audit-result.json"),
    handoffArchive: archivePath,
    handoffArchiveRecordCount: archive.records.length
  }],
  safety: {
    noOriginalExternalRepoMutation: true,
    readOnlyOverExistingArtifacts: true,
    noAutoApplyByRunForge: true,
    noProviderCalls: true,
    noNetworkRequired: true,
    noDbAccess: true,
    noPushMergeDeploy: true
  },
  visibility: {
    packetIndex: join(tmpRoot, "index", "index.json"),
    lifecycleReport: "validation/runs/ALPHA-26/lifecycle-report.json"
  },
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(preliminaryResults, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(tmpRoot, "index"), "--dashboard-seed"]);
const indexMarkdown = await readFile(join(tmpRoot, "index", "index.md"), "utf8");
check(indexMarkdown.includes("handoff_archive_search_ready"), "packet index should expose Alpha-26 archive outcome");
check(indexMarkdown.includes(archivePath), "packet index should expose handoff archive path");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-26",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.handoffArchiveCounts.records >= 1, "lifecycle should expose archived handoff count");
check(lifecycle.handoffArchiveRecommendations.length > 0, "lifecycle should expose archive recommendations");
await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-26-compact-lifecycle-report",
  generatedAt: lifecycle.generatedAt,
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  operatorTrialCounts: lifecycle.operatorTrialCounts,
  handoffPacketCounts: lifecycle.handoffPacketCounts,
  handoffArchiveCounts: lifecycle.handoffArchiveCounts,
  handoffArchiveRecommendations: lifecycle.handoffArchiveRecommendations,
  visibility: {
    packetIndexHasArchive: indexMarkdown.includes(archivePath),
    lifecycleHasArchiveCounts: lifecycle.handoffArchiveCounts.records >= 1
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-26") || line.includes("Alpha-25") || line.includes("Alpha-24")),
  findings: lifecycle.findings,
  recommendations: lifecycle.recommendations,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
}, null, 2)}\n`, "utf8");

const finalResults = {
  ...preliminaryResults,
  visibility: {
    ...preliminaryResults.visibility,
    packetIndexHasArchive: indexMarkdown.includes(archivePath),
    lifecycleHasArchiveCounts: lifecycle.handoffArchiveCounts.records >= 1,
    lifecycleArchiveCounts: lifecycle.handoffArchiveCounts
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

console.log("Alpha-26 validation passed.");
console.log(`Archive: ${archivePath}`);
console.log(`Records: ${archive.records.length}`);

async function writeHandoffFixture(dir: string, input: { id: string; repoPath: string; validationCommand: string; unsafe: boolean }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "README.md"), [
    "# Operator Handoff",
    "",
    "RunForge proposes only.",
    "Original repo must remain unchanged.",
    input.unsafe ? "Unsafe demo packet: validation command is intentionally forbidden for archive rejection evidence." : "Safe demo packet."
  ].join("\n"), "utf8");
  await writeFile(join(dir, "proposal.patch"), "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
  await writeFile(join(dir, "operator-summary.md"), "Operator summary.\n", "utf8");
  await writeFile(join(dir, "handoff.json"), `${JSON.stringify({
    schemaVersion: "alpha-24-operator-handoff",
    trialId: input.id,
    generatedAt: new Date().toISOString(),
    sourceRepo: { path: input.repoPath, headBefore: "demo-before", headAfter: "demo-before", statusBefore: "", statusAfter: "", originalRepoMutated: false, mutationVerdict: "unchanged" },
    worktree: { path: join(tmpRoot, "operator-worktree", input.id), type: "disposable_operator_worktree" },
    failure: { command: input.validationCommand, status: "failed", summary: "Demo failure." },
    proposal: { outcome: "proposal_ready_verified", patchPath: "proposal.patch", autoAppliedByRunForge: input.unsafe, operatorReviewRequired: true },
    manualApply: { allowedTarget: input.unsafe ? "original_repo" : "disposable_operator_worktree", forbiddenTarget: "original_repo", instructionsPath: "apply-instructions.md" },
    validation: { command: input.validationCommand, instructionsPath: "validation.md" },
    rollback: { instructionsPath: "rollback.md" },
    decisionForms: { accepted: "decision-form.accepted.json", rejected: "decision-form.rejected.json" },
    safety: { providerUsed: false, networkUsed: false, dbUsed: false, deployUsed: false, pushUsed: input.unsafe, mergeUsed: false },
    evidence: { packetPath: "unknown", operatorSummaryPath: join(dir, "operator-summary.md"), lifecycleReportPath: join(validationDir, "lifecycle-report.json"), evidenceLinksPath: "evidence-links.json" }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "decision-form.accepted.json"), `${JSON.stringify({ decision: "accepted", appliedBy: "operator_manual", appliedTo: "disposable_copy", originalRepoMutated: false, runforgeAppliedPatch: false, afterValidation: "passed" }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "decision-form.rejected.json"), `${JSON.stringify({ decision: "rejected", reason: "operator_declined", originalRepoMutated: false, runforgeAppliedPatch: false, appliedTo: "disposable_copy" }, null, 2)}\n`, "utf8");
}

async function writeAuditFixture(dir: string, handoffDir: string, status: "passed" | "failed", validationStatus: "passed" | "skipped", findings: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const result = {
    auditId: status === "passed" ? "alpha26-accepted-audit" : "alpha26-unsafe-audit",
    handoffPath: handoffDir,
    status,
    sourceRepo: { path: "/tmp/runforge-alpha26-handoff-archive/repos/factory", headBefore: "demo-before", headAfter: "demo-before", statusBefore: "", statusAfter: "", originalRepoMutated: false },
    replay: { worktreePath: join(tmpRoot, "replay-worktree", status), patchApplied: status === "passed", validationRun: status === "passed", validationStatus },
    decisionForms: { acceptedValid: true, rejectedValid: true },
    safety: { unsafeInstructionsFound: status === "failed", forbiddenTargetsFound: status === "failed", providerUsed: false, networkUsed: false, dbUsed: false, deployUsed: false, pushUsed: false, mergeUsed: false },
    findings,
    recommendations: status === "passed" ? ["Handoff is complete, replayable, auditable, and safe for operator review in a disposable worktree."] : ["Do not trust this handoff until unsafe instructions are removed."],
    artifacts: { auditReport: join(dir, "audit-report.md"), auditResult: join(dir, "audit-result.json"), replayLog: join(dir, "replay-log.json") }
  };
  await writeFile(join(dir, "audit-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "audit-report.md"), `# Audit ${status}\n`, "utf8");
  await writeFile(join(dir, "replay-log.json"), `${JSON.stringify({ entries: [] }, null, 2)}\n`, "utf8");
}

async function writeResultsFixture(path: string, safeHandoff: string, safeAudit: string, unsafeHandoff: string, unsafeAudit: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: "alpha-26-demo-source-results",
    generatedAt: new Date().toISOString(),
    originalRepo: { path: "/tmp/runforge-alpha26-handoff-archive/repos/factory", beforeHead: "demo-before", afterHead: "demo-before", mutationVerdict: "unchanged" },
    attempts: [
      {
        id: "alpha26-accepted-audited",
        repo: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
        decision: "accepted",
        outcome: "handoff_audit_passed",
        providerStatus: "disabled",
        manualApply: false,
        appliedTo: "disposable_replay_worktree",
        originalRepoMutated: false,
        validationBefore: "failed",
        validationAfter: "passed",
        proposalPatch: join(safeHandoff, "proposal.patch"),
        handoffReadme: join(safeHandoff, "README.md"),
        handoffJson: join(safeHandoff, "handoff.json"),
        handoffAuditStatus: "passed",
        handoffAuditReport: join(safeAudit, "audit-report.md"),
        handoffAuditResult: join(safeAudit, "audit-result.json")
      },
      {
        id: "alpha26-unsafe-rejected",
        repo: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
        decision: "rejected",
        outcome: "handoff_audit_failed",
        providerStatus: "disabled",
        manualApply: false,
        appliedTo: "none",
        originalRepoMutated: false,
        validationBefore: "failed",
        validationAfter: "skipped",
        proposalPatch: join(unsafeHandoff, "proposal.patch"),
        handoffReadme: join(unsafeHandoff, "README.md"),
        handoffJson: join(unsafeHandoff, "handoff.json"),
        handoffAuditStatus: "failed",
        handoffAuditReport: join(unsafeAudit, "audit-report.md"),
        handoffAuditResult: join(unsafeAudit, "audit-result.json")
      }
    ]
  }, null, 2)}\n`, "utf8");
}

function malformedRecord(): HandoffArchiveRecord {
  return {
    id: "malformed",
    repoPath: "/tmp/runforge-alpha26-handoff-archive/repos/factory",
    repoName: "factory",
    handoffPath: "unknown",
    handoffReadmePath: "unknown",
    patchPath: "missing",
    auditResultPath: "unknown",
    auditReportPath: "unknown",
    decisionPath: "unknown",
    operatorSummaryPath: "unknown",
    lifecycleReportPath: "unknown",
    auditStatus: "passed",
    decisionVerdict: "accepted",
    validationBefore: "failed",
    validationAfter: "failed",
    originalRepoMutated: true,
    safetyStatus: "unsafe",
    unsafeReasons: [],
    lifecycleRefs: [],
    validationCommands: [],
    createdFromAlpha: "ALPHA-26",
    findings: [],
    recommendations: []
  };
}

async function runCli(args: string[]): Promise<void> {
  const display = `pnpm dev ${args.join(" ")}`;
  commandsRun.push(display);
  const { stdout, stderr } = await execFileAsync("pnpm", ["dev", ...args], { cwd: repo, timeout: 180000 });
  if (stdout.trim()) commandsRun.push(`# stdout: ${stdout.trim().split("\n")[0]}`);
  if (stderr.trim()) commandsRun.push(`# stderr: ${stderr.trim().split("\n")[0]}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeSummary(results: typeof finalResults): Promise<void> {
  await writeFile(join(validationDir, "summary.md"), [
    "# Alpha-26 Operator Handoff Archive / Search",
    "",
    `Final verdict: ${results.finalVerdict}`,
    "",
    "## Archive",
    "",
    `- Roots scanned: ${results.archiveRootsScanned.join(", ")}`,
    `- Records: ${results.archive.records}`,
    `- By repo: ${JSON.stringify(results.archive.counts.byRepo)}`,
    `- By decision: ${JSON.stringify(results.archive.counts.byDecision)}`,
    `- By audit: ${JSON.stringify(results.archive.counts.byAuditStatus)}`,
    `- By safety: ${JSON.stringify(results.archive.counts.bySafetyStatus)}`,
    `- By validation after: ${JSON.stringify(results.archive.counts.byValidationAfter)}`,
    "",
    "## Search",
    "",
    `- Accepted/passed matches: ${results.searchExamples.acceptedPassed.matchingCount}`,
    `- Zero-result matches: ${results.searchExamples.zeroResults.matchingCount}`,
    "",
    "## Validation",
    "",
    `- Archive validation: ${results.archive.validation.passed ? "passed" : "failed"}`,
    `- Malformed negative validation: ${results.negativeValidation.passed ? "unexpected pass" : "failed as expected"}`,
    "",
    "## Visibility",
    "",
    `- Packet index has archive: ${results.visibility.packetIndexHasArchive}`,
    `- Lifecycle has archive counts: ${results.visibility.lifecycleHasArchiveCounts}`,
    "",
    "## Known Limitations",
    "",
    "- Alpha-26 builds a read-only archive/search layer; it does not auto-apply, push, merge, deploy, or promote skills.",
    "- Archive records depend on available local artifacts and tolerate missing optional historical files.",
    "",
    `Evidence JSON: validation/runs/ALPHA-26/results.json`
  ].join("\n") + "\n", "utf8");
}
