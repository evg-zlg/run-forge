import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHandoffArchive, searchHandoffArchive, validateHandoffArchiveRecords, type HandoffArchiveRecord } from "../../src/run/external-operator-handoff-archive.js";
import { buildHandoffArchiveViewer, validateHandoffArchiveViewer } from "../../src/run/external-operator-handoff-archive-viewer.js";

describe("operator handoff archive", () => {
  it("builds and searches a compact handoff/audit archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-handoff-archive-"));
    const handoffDir = join(root, "ALPHA-26", "handoff");
    const auditDir = join(root, "ALPHA-26", "audit");
    await mkdir(handoffDir, { recursive: true });
    await mkdir(auditDir, { recursive: true });
    await writeFile(join(handoffDir, "README.md"), "RunForge proposes only. Original repo must remain unchanged.\n", "utf8");
    await writeFile(join(handoffDir, "proposal.patch"), "diff --git a/a.txt b/a.txt\n", "utf8");
    await writeFile(join(handoffDir, "handoff.json"), `${JSON.stringify({
      sourceRepo: { path: "/tmp/factory", originalRepoMutated: false },
      proposal: { patchPath: "proposal.patch", autoAppliedByRunForge: false },
      manualApply: { allowedTarget: "disposable_operator_worktree" },
      validation: { command: "node verify.cjs" },
      safety: { providerUsed: false, networkUsed: false, dbUsed: false, deployUsed: false, pushUsed: false, mergeUsed: false },
      evidence: { operatorSummaryPath: join(handoffDir, "operator-summary.md"), lifecycleReportPath: join(root, "ALPHA-26", "lifecycle-report.json") }
    }, null, 2)}\n`, "utf8");
    await writeFile(join(auditDir, "audit-result.json"), `${JSON.stringify({
      handoffPath: handoffDir,
      status: "passed",
      sourceRepo: { path: "/tmp/factory", originalRepoMutated: false },
      replay: { validationStatus: "passed" },
      safety: { unsafeInstructionsFound: false, forbiddenTargetsFound: false },
      artifacts: { auditReport: join(auditDir, "audit-report.md"), auditResult: join(auditDir, "audit-result.json") },
      findings: []
    }, null, 2)}\n`, "utf8");
    await writeFile(join(auditDir, "audit-report.md"), "# Audit\n", "utf8");

    const archive = await buildHandoffArchive({ root, out: join(root, "archive") });
    expect(archive.records).toHaveLength(1);
    expect(archive.counts.byRepo.factory).toBe(1);
    expect(archive.counts.byAuditStatus.passed).toBe(1);
    expect(archive.validation.passed).toBe(true);

    const found = await searchHandoffArchive({ archive: join(root, "archive", "handoff-archive.json"), filters: { repo: "factory", auditStatus: "passed" } });
    expect(found.matchingCount).toBe(1);
    const empty = await searchHandoffArchive({ archive: join(root, "archive", "handoff-archive.json"), filters: { repo: "missing-repo" } });
    expect(empty.matchingCount).toBe(0);
  });

  it("validates unsafe and malformed archive records", () => {
    const base: HandoffArchiveRecord = {
      id: "bad",
      repoPath: "/tmp/factory",
      repoName: "factory",
      handoffPath: "unknown",
      handoffReadmePath: "unknown",
      patchPath: "missing",
      auditResultPath: "unknown",
      auditReportPath: "unknown",
      decisionPath: "unknown",
      operatorSummaryPath: "unknown",
      lifecycleReportPath: "https://example.invalid/lifecycle.json",
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
    const validation = validateHandoffArchiveRecords([base, { ...base }]);
    expect(validation.passed).toBe(false);
    expect(validation.errors.join("\n")).toContain("duplicate record id");
    expect(validation.errors.join("\n")).toContain("accepted decision requires validationAfter=passed");
    expect(validation.errors.join("\n")).toContain("original repo mutated true");
    expect(validation.errors.join("\n")).toContain("unsafe status requires reasons");
    expect(validation.errors.join("\n")).toContain("malformed local path");
  });

  it("generates and validates a local static archive viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-handoff-viewer-"));
    const archivePath = join(root, "handoff-archive.json");
    const out = join(root, "viewer");
    const record: HandoffArchiveRecord = {
      id: "unsafe-rejected",
      repoPath: "/tmp/factory",
      repoName: "factory",
      handoffPath: join(root, "handoff.json"),
      handoffReadmePath: join(root, "README.md"),
      patchPath: join(root, "proposal.patch"),
      auditResultPath: join(root, "audit-result.json"),
      auditReportPath: join(root, "audit-report.md"),
      decisionPath: "unknown",
      operatorSummaryPath: "unknown",
      lifecycleReportPath: "unknown",
      auditStatus: "failed",
      decisionVerdict: "rejected",
      validationBefore: "failed",
      validationAfter: "skipped",
      originalRepoMutated: false,
      safetyStatus: "unsafe",
      unsafeReasons: ["audit found forbidden push operation"],
      lifecycleRefs: [],
      validationCommands: ["git push origin main"],
      createdFromAlpha: "ALPHA-27",
      findings: ["unsafe: audit found forbidden push operation"],
      recommendations: ["Candidate safety lesson: rejected unsafe handoff for repo factory."]
    };
    await writeFile(archivePath, `${JSON.stringify({
      schemaVersion: "alpha-26-handoff-archive",
      generatedAt: new Date().toISOString(),
      root,
      records: [record],
      counts: {
        records: 1,
        byRepo: { factory: 1 },
        byDecision: { rejected: 1 },
        byAuditStatus: { failed: 1 },
        bySafetyStatus: { unsafe: 1 },
        byValidationAfter: { skipped: 1 }
      },
      findings: record.findings,
      recommendations: record.recommendations,
      validation: { passed: true, errors: [] }
    }, null, 2)}\n`, "utf8");

    const result = await buildHandoffArchiveViewer({ archive: archivePath, out });
    expect(result.records).toHaveLength(1);
    expect(result.validation.passed).toBe(true);
    const html = await readFile(join(out, "index.html"), "utf8");
    expect(html).toContain("Operator Handoff Archive Viewer");
    expect(html).toContain("UNSAFE");
    expect(html).toContain("No handoff archive records match the current filters.");
    expect(html).toContain("[redacted unsafe command: see handoff and audit artifacts]");
    expect(html).not.toContain("git push origin main");
    const validation = await validateHandoffArchiveViewer({ archivePath, outDir: out });
    expect(validation.passed).toBe(true);
  });
});
