import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";
import { validateHandoffArchiveViewer, type HandoffArchiveViewerResult } from "../src/run/external-operator-handoff-archive-viewer.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const tmpRoot = "/tmp/runforge-alpha27-handoff-archive-viewer";
const sourceRoot = join(tmpRoot, "source");
const archiveDir = join(tmpRoot, "archive");
const viewerDir = join(tmpRoot, "viewer");
const indexDir = join(tmpRoot, "index");
const dashboardDir = join(tmpRoot, "dashboard");
const validationDir = join(repo, "validation/runs/ALPHA-27");
const trackedViewerDir = join(validationDir, "viewer");
const errors: string[] = [];
const commandsRun: string[] = [];

await rm(tmpRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(sourceRoot, { recursive: true });
await mkdir(validationDir, { recursive: true });

const safeHandoffDir = join(sourceRoot, "ALPHA-27-DEMO", "accepted-handoff");
const safeAuditDir = join(sourceRoot, "ALPHA-27-DEMO", "accepted-audit");
const unsafeHandoffDir = join(sourceRoot, "ALPHA-27-DEMO", "unsafe-handoff");
const unsafeAuditDir = join(sourceRoot, "ALPHA-27-DEMO", "unsafe-audit");
await writeHandoffFixture(safeHandoffDir, {
  id: "alpha27-accepted-audited",
  repoPath: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory",
  validationCommand: "node verify.cjs",
  unsafe: false
});
await writeAuditFixture(safeAuditDir, safeHandoffDir, "passed", "passed", []);
await writeHandoffFixture(unsafeHandoffDir, {
  id: "alpha27-unsafe-rejected",
  repoPath: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory",
  validationCommand: "git push origin main",
  unsafe: true
});
await writeAuditFixture(unsafeAuditDir, unsafeHandoffDir, "failed", "skipped", ["validation command attempts forbidden push operation", "handoff proposal autoAppliedByRunForge=true"]);
await writeResultsFixture(join(sourceRoot, "ALPHA-27-DEMO", "results.json"), safeHandoffDir, safeAuditDir, unsafeHandoffDir, unsafeAuditDir);

await runCli(["external", "handoff-archive", "--root", sourceRoot, "--out", archiveDir]);
const archivePath = join(archiveDir, "handoff-archive.json");
await runCli(["external", "handoff-archive-viewer", "--archive", archivePath, "--out", viewerDir]);
await runCli(["external", "handoff-archive-viewer-validate", "--archive", archivePath, "--viewer", viewerDir]);
const archive = await readJson<{ records: unknown[]; counts: Record<string, unknown>; recommendations: string[] }>(archivePath);
const viewerSummary = await readJson<{ counts: { records: number }; filters: { zeroResultMessage: string }; recommendations: string[] }>(join(viewerDir, "archive-summary.json"));
const viewerRecords = await readJson<Array<{ safetyStatus: string; decisionVerdict: string; auditStatus: string; validationAfter: string; mutationVerdict: string; displayValidationCommands: string[] }>>(join(viewerDir, "records.json"));
const viewerHtml = await readFile(join(viewerDir, "index.html"), "utf8");
const viewerValidation = await validateHandoffArchiveViewer({ archivePath, outDir: viewerDir });

check(archive.records.length === 2, "archive should render two records in viewer validation demo");
check(viewerSummary.counts.records === archive.records.length, "viewer summary count should match archive records");
check(viewerRecords.length === archive.records.length, "viewer records count should match archive records");
check(viewerRecords.some((record) => record.decisionVerdict === "accepted" && record.auditStatus === "passed" && record.validationAfter === "passed"), "viewer records should include accepted/passed handoff");
check(viewerRecords.some((record) => record.decisionVerdict === "rejected" && record.safetyStatus === "unsafe"), "viewer records should include unsafe rejected handoff");
check(viewerRecords.some((record) => record.displayValidationCommands.includes("[redacted unsafe command: see handoff and audit artifacts]")), "viewer should redact unsafe validation commands");
check(!JSON.stringify(viewerRecords).includes("git push origin main"), "viewer records should not expose executable unsafe command text");
check(viewerHtml.includes("data-safety-status=\"unsafe\"") && viewerHtml.includes("UNSAFE"), "viewer HTML should visibly mark unsafe records");
check(viewerHtml.includes("filter-repo") && viewerHtml.includes("filter-decision") && viewerHtml.includes("filter-audit") && viewerHtml.includes("filter-safety") && viewerHtml.includes("filter-validation") && viewerHtml.includes("filter-mutated"), "viewer should expose required filter controls");
check(viewerHtml.includes(viewerSummary.filters.zeroResultMessage), "viewer should document zero-result filter state");
check(viewerHtml.includes("Read-only local viewer"), "viewer should show read-only safety banner");
check(viewerValidation.passed, `viewer validation should pass: ${viewerValidation.errors.join("; ")}`);

await mkdir(trackedViewerDir, { recursive: true });
await cp(join(viewerDir, "index.html"), join(trackedViewerDir, "index.html"));
await cp(join(viewerDir, "archive-summary.json"), join(trackedViewerDir, "archive-summary.json"));
await cp(join(viewerDir, "records.json"), join(trackedViewerDir, "records.json"));
await cp(archivePath, join(validationDir, "handoff-archive.json"));

const preliminaryResults = {
  schemaVersion: "alpha-27-handoff-archive-viewer",
  generatedAt: new Date().toISOString(),
  archiveSource: archivePath,
  viewer: {
    command: `pnpm dev external handoff-archive-viewer --archive ${archivePath} --out ${viewerDir}`,
    out: viewerDir,
    indexHtml: join(viewerDir, "index.html"),
    trackedIndexHtml: "validation/runs/ALPHA-27/viewer/index.html",
    trackedSummary: "validation/runs/ALPHA-27/viewer/archive-summary.json",
    trackedRecords: "validation/runs/ALPHA-27/viewer/records.json",
    recordsRendered: viewerRecords.length,
    countsRendered: viewerSummary.counts,
    validation: viewerValidation
  },
  filters: {
    repoSubstring: true,
    decision: true,
    auditStatus: true,
    safetyStatus: true,
    validationStatus: true,
    originalMutationVerdict: true,
    zeroResultMessage: viewerSummary.filters.zeroResultMessage
  },
  unsafeRejectedVisibility: {
    unsafeRowsMarked: viewerHtml.includes("data-safety-status=\"unsafe\""),
    unsafeBadgeRendered: viewerHtml.includes("UNSAFE"),
    rejectedUnsafeRecords: viewerRecords.filter((record) => record.decisionVerdict === "rejected" && record.safetyStatus === "unsafe").length
  },
  recommendationsRendered: viewerSummary.recommendations,
  safety: {
    noOriginalExternalRepoMutation: true,
    readOnlyStaticViewer: true,
    noAutoApplyByRunForge: true,
    noProviderCalls: true,
    noNetworkRequired: true,
    noDbAccess: true,
    noPushMergeDeployActions: true,
    unsafeCommandsRedacted: !JSON.stringify(viewerRecords).includes("git push origin main")
  },
  visibility: {
    packetIndex: join(indexDir, "index.json"),
    dashboardData: join(dashboardDir, "dashboard-data.json"),
    lifecycleReport: "validation/runs/ALPHA-27/lifecycle-report.json",
    archiveViewerPath: join(viewerDir, "index.html")
  },
  attempts: [{
    id: "alpha27-handoff-archive-viewer",
    repo: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory",
    decision: "handoff_archive_viewer_generated",
    packet: viewerDir,
    viewer: join(viewerDir, "index.html"),
    outcome: "handoff_archive_viewer_ready",
    providerStatus: "disabled",
    filesChanged: [],
    manualApply: false,
    appliedTo: "read_only_static_viewer",
    originalRepoMutated: false,
    validationBefore: "failed",
    validationAfter: viewerValidation.passed ? "passed" : "failed",
    proposalPatch: join(safeHandoffDir, "proposal.patch"),
    handoffReadme: join(safeHandoffDir, "README.md"),
    handoffJson: join(safeHandoffDir, "handoff.json"),
    handoffAuditStatus: "passed",
    handoffAuditReport: join(safeAuditDir, "audit-report.md"),
    handoffAuditResult: join(safeAuditDir, "audit-result.json"),
    handoffArchive: archivePath,
    handoffArchiveRecordCount: viewerRecords.length
  }],
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(preliminaryResults, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", indexDir, "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(indexDir, "dashboard-seed.json"), "--out", dashboardDir]);
const indexMarkdown = await readFile(join(indexDir, "index.md"), "utf8");
const dashboardData = await readJson<{ records?: Array<{ alpha?: string; viewerPath?: string; handoffArchivePath?: string }> }>(join(dashboardDir, "dashboard-data.json"));
check(indexMarkdown.includes(join(viewerDir, "index.html")), "packet index should expose Alpha-27 viewer path");
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-27" && record.viewerPath === join(viewerDir, "index.html")), "dashboard data should expose Alpha-27 viewer path");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-27",
  skillRoots: [join(repo, ".agents/skills")]
});
await rm(join(validationDir, "generated"), { recursive: true, force: true });
check(lifecycle.handoffArchiveCounts.records >= viewerRecords.length, "lifecycle should include archived handoff counts");
await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-27-compact-lifecycle-report",
  generatedAt: lifecycle.generatedAt,
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  operatorTrialCounts: lifecycle.operatorTrialCounts,
  handoffPacketCounts: lifecycle.handoffPacketCounts,
  handoffArchiveCounts: lifecycle.handoffArchiveCounts,
  handoffArchiveRecommendations: lifecycle.handoffArchiveRecommendations,
  archiveViewer: {
    generated: true,
    path: "validation/runs/ALPHA-27/viewer/index.html",
    recordsRendered: viewerRecords.length,
    validationPassed: viewerValidation.passed
  },
  visibility: {
    packetIndexHasViewer: indexMarkdown.includes(join(viewerDir, "index.html")),
    dashboardDataHasViewer: (dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-27" && record.viewerPath === join(viewerDir, "index.html")),
    lifecycleHasArchiveCounts: lifecycle.handoffArchiveCounts.records >= viewerRecords.length
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-27") || line.includes("Alpha-26") || line.includes("Alpha-25")),
  findings: lifecycle.findings,
  recommendations: lifecycle.recommendations,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
}, null, 2)}\n`, "utf8");

const finalResults = {
  ...preliminaryResults,
  visibility: {
    ...preliminaryResults.visibility,
    packetIndexHasViewer: indexMarkdown.includes(join(viewerDir, "index.html")),
    dashboardDataHasViewer: (dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-27" && record.viewerPath === join(viewerDir, "index.html")),
    lifecycleHasArchiveCounts: lifecycle.handoffArchiveCounts.records >= viewerRecords.length,
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

console.log("Alpha-27 validation passed.");
console.log(`Viewer: ${join(viewerDir, "index.html")}`);
console.log(`Records: ${viewerRecords.length}`);

async function writeHandoffFixture(dir: string, input: { id: string; repoPath: string; validationCommand: string; unsafe: boolean }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "README.md"), [
    "# Operator Handoff",
    "",
    "RunForge proposes only.",
    "Original repo must remain unchanged.",
    input.unsafe ? "Unsafe demo packet: validation command is intentionally forbidden for archive viewer rejection evidence." : "Safe demo packet."
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
    auditId: status === "passed" ? "alpha27-accepted-audit" : "alpha27-unsafe-audit",
    handoffPath: handoffDir,
    status,
    sourceRepo: { path: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory", headBefore: "demo-before", headAfter: "demo-before", statusBefore: "", statusAfter: "", originalRepoMutated: false },
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
    schemaVersion: "alpha-27-demo-source-results",
    generatedAt: new Date().toISOString(),
    originalRepo: { path: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory", beforeHead: "demo-before", afterHead: "demo-before", mutationVerdict: "unchanged" },
    attempts: [
      {
        id: "alpha27-accepted-audited",
        repo: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory",
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
        id: "alpha27-unsafe-rejected",
        repo: "/tmp/runforge-alpha27-handoff-archive-viewer/repos/factory",
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
    "# Alpha-27 Operator Handoff Archive Viewer",
    "",
    `Final verdict: ${results.finalVerdict}`,
    "",
    "## Viewer",
    "",
    `- Archive source: ${results.archiveSource}`,
    `- Viewer command: ${results.viewer.command}`,
    `- Viewer output: ${results.viewer.out}`,
    `- Tracked viewer: ${results.viewer.trackedIndexHtml}`,
    `- Records rendered: ${results.viewer.recordsRendered}`,
    `- Counts rendered: ${JSON.stringify(results.viewer.countsRendered)}`,
    `- Viewer validation: ${results.viewer.validation.passed ? "passed" : "failed"}`,
    "",
    "## Filters",
    "",
    `- Repo substring: ${results.filters.repoSubstring}`,
    `- Decision/audit/safety/validation/original-mutation filters: ${results.filters.decision && results.filters.auditStatus && results.filters.safetyStatus && results.filters.validationStatus && results.filters.originalMutationVerdict}`,
    `- Zero-result message: ${results.filters.zeroResultMessage}`,
    "",
    "## Safety",
    "",
    `- Read-only static viewer: ${results.safety.readOnlyStaticViewer}`,
    `- No original external repo mutation: ${results.safety.noOriginalExternalRepoMutation}`,
    `- Unsafe commands redacted in viewer data: ${results.safety.unsafeCommandsRedacted}`,
    `- Unsafe/rejected records marked: ${results.unsafeRejectedVisibility.unsafeRowsMarked && results.unsafeRejectedVisibility.unsafeBadgeRendered}`,
    "",
    "## Visibility",
    "",
    `- Packet index has viewer: ${results.visibility.packetIndexHasViewer}`,
    `- Dashboard data has viewer: ${results.visibility.dashboardDataHasViewer}`,
    `- Lifecycle has archive counts: ${results.visibility.lifecycleHasArchiveCounts}`,
    `- Lifecycle report: ${results.visibility.lifecycleReport}`,
    "",
    "## Known Limitations",
    "",
    "- Alpha-27 is a static local viewer over existing archive artifacts; it does not auto-apply, push, merge, deploy, or promote skills.",
    "- File links are rendered as local paths for operator copy/open workflows; no server or browser automation is required.",
    "",
    `Evidence JSON: validation/runs/ALPHA-27/results.json`
  ].join("\n") + "\n", "utf8");
}
