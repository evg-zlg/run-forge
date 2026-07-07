import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHandoffArchive, searchHandoffArchive, validateHandoffArchiveRecords, type HandoffArchiveRecord } from "../../src/run/external-operator-handoff-archive.js";

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
});
