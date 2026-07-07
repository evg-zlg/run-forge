import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateOperatorHandoffPacket } from "../../src/run/external-operator-handoff.js";

describe("operator handoff packet validation", () => {
  it("accepts a complete safe handoff bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-handoff-safe-"));
    await writeHandoff(root);

    const result = await validateOperatorHandoffPacket(root);

    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("rejects missing and unsafe handoff fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-handoff-unsafe-"));
    await writeHandoff(root, {
      proposal: { autoAppliedByRunForge: true },
      manualApply: { allowedTarget: "original_repo" },
      sourceRepo: { originalRepoMutated: true },
      safety: { pushUsed: true }
    });
    await writeFile(join(root, "apply-instructions.md"), [
      "# Manual Apply Instructions",
      "",
      "RunForge proposes only. Original repo must remain unchanged.",
      "",
      "```bash",
      "git push origin main",
      "```",
      ""
    ].join("\n"), "utf8");

    const result = await validateOperatorHandoffPacket(root);

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "handoff.json proposal.autoAppliedByRunForge must be false",
      "handoff.json manualApply.allowedTarget must be disposable_operator_worktree",
      "handoff.json sourceRepo.originalRepoMutated must be false",
      "handoff.json safety.pushUsed must be false",
      "handoff instructions must not include push, merge, or deploy commands"
    ]));
  });

  it("rejects incomplete decision forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-handoff-decision-"));
    await writeHandoff(root);
    const accepted = JSON.parse(await readFile(join(root, "decision-form.accepted.json"), "utf8")) as Record<string, unknown>;
    delete accepted.afterValidation;
    await writeFile(join(root, "decision-form.accepted.json"), `${JSON.stringify(accepted, null, 2)}\n`, "utf8");

    const result = await validateOperatorHandoffPacket(root);

    expect(result.passed).toBe(false);
    expect(result.errors).toContain("accepted decision form missing afterValidation=passed");
  });
});

async function writeHandoff(root: string, overrides: {
  proposal?: Record<string, unknown>;
  manualApply?: Record<string, unknown>;
  sourceRepo?: Record<string, unknown>;
  safety?: Record<string, unknown>;
} = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  const safety = {
    providerUsed: false,
    networkUsed: false,
    dbUsed: false,
    deployUsed: false,
    pushUsed: false,
    mergeUsed: false,
    ...overrides.safety
  };
  const handoff = {
    schemaVersion: "alpha-24-operator-handoff",
    trialId: "unit-handoff",
    generatedAt: "2026-07-07T00:00:00.000Z",
    sourceRepo: {
      path: "/repo",
      headBefore: "abc",
      headAfter: "abc",
      statusBefore: "",
      statusAfter: "",
      originalRepoMutated: false,
      mutationVerdict: "unchanged",
      ...overrides.sourceRepo
    },
    worktree: {
      path: "/tmp/operator-worktree",
      type: "disposable_operator_worktree"
    },
    failure: {
      command: "node verify.js",
      status: "failed",
      summary: "validation failed"
    },
    proposal: {
      outcome: "proposal_ready_verified",
      patchPath: "proposal.patch",
      autoAppliedByRunForge: false,
      operatorReviewRequired: true,
      ...overrides.proposal
    },
    manualApply: {
      allowedTarget: "disposable_operator_worktree",
      forbiddenTarget: "original_repo",
      instructionsPath: "apply-instructions.md",
      ...overrides.manualApply
    },
    validation: {
      command: "node verify.js",
      instructionsPath: "validation.md"
    },
    rollback: {
      instructionsPath: "rollback.md"
    },
    decisionForms: {
      accepted: "decision-form.accepted.json",
      rejected: "decision-form.rejected.json"
    },
    safety,
    evidence: {
      packetPath: "/tmp/packet",
      operatorSummaryPath: "/tmp/operator-summary.md",
      lifecycleReportPath: "/tmp/lifecycle-report.json",
      evidenceLinksPath: "evidence-links.json"
    }
  };
  await writeFile(join(root, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  await writeFile(join(root, "README.md"), "RunForge proposes only. Original repo must remain unchanged.\n", "utf8");
  await writeFile(join(root, "proposal.patch"), "diff --git a/file b/file\n", "utf8");
  await writeFile(join(root, "apply-instructions.md"), "RunForge proposes only. Original repo must remain unchanged.\n", "utf8");
  await writeFile(join(root, "validation.md"), "RunForge proposes only. Original repo must remain unchanged.\n", "utf8");
  await writeFile(join(root, "rollback.md"), "RunForge proposes only. Original repo must remain unchanged.\n", "utf8");
  await writeFile(join(root, "decision-form.accepted.json"), `${JSON.stringify({
    decision: "accepted",
    appliedBy: "operator_manual",
    appliedTo: "disposable_copy",
    originalRepoMutated: false,
    afterValidation: "passed"
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "decision-form.rejected.json"), `${JSON.stringify({
    decision: "rejected",
    reason: "operator_declined",
    originalRepoMutated: false
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "evidence-links.json"), "{}\n", "utf8");
}
