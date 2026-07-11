import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRepairTargetSafe, ownerDecisionPermitsApply, reviewPatchText, validateExternalExecutionModes, validateOwnerDecisionForContinuation, type ContinuationState, type OwnerDecision } from "../../src/run/external-execution.js";

const valid = {
  task: "repair",
  out: "validation/runs/EXTERNAL-EXECUTION-TEST",
  repo: "/external/repo",
  runtime: "docker",
  dockerImage: "runforge:local",
  prepareRuntime: "explicit",
  repairMode: "disposable",
  approvalMode: "require-owner-decision",
  applyMode: "none",
  commands: [],
  timeoutMs: 1_000
};

describe("external execution gates", () => {
  it("accepts the owner-gated disposable contour", () => {
    expect(() => validateExternalExecutionModes(valid)).not.toThrow();
  });

  it("requires an explicit target for local non-main branch apply", () => {
    expect(() => validateExternalExecutionModes({ ...valid, applyMode: "local-non-main-branch" })).toThrow("requires --target-branch");
    expect(() => validateExternalExecutionModes({ ...valid, applyMode: "local-non-main-branch", targetBranch: "runforge/demo" })).not.toThrow();
  });

  it("requires local branch apply for draft publication", () => {
    expect(() => validateExternalExecutionModes({ ...valid, publicationMode: "draft-pr" })).toThrow("requires local non-main branch apply");
    expect(() => validateExternalExecutionModes({ ...valid, applyMode: "local-non-main-branch", targetBranch: "runforge/demo", publicationMode: "draft-pr" })).not.toThrow();
  });

  it("requires a plan only for code repair mode", () => {
    expect(() => validateExternalExecutionModes({ ...valid, repairMode: "code" })).toThrow("requires --repair-plan");
    expect(() => validateExternalExecutionModes({ ...valid, repairMode: "code", repairPlan: "plan.json" })).not.toThrow();
    expect(() => validateExternalExecutionModes({ ...valid, repairPlan: "plan.json" })).toThrow("requires --repair-mode code");
  });

  it.each([
    [{ runtime: "local" }, "--runtime docker"],
    [{ prepareRuntime: "none" }, "--prepare-runtime explicit"],
    [{ repairMode: "in-place" }, "only 'disposable'"],
    [{ approvalMode: "automatic" }, "only 'require-owner-decision'"],
    [{ applyMode: "main" }, "only 'none'"]
  ])("rejects unsafe mode %j", (override, message) => {
    expect(() => validateExternalExecutionModes({ ...valid, ...override })).toThrow(message);
  });

  it("accepts only the single expected README patch", () => {
    expect(reviewPatchText("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n")).toBe(true);
    expect(reviewPatchText("diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n")).toBe(false);
  });

  it("rejects a repair symlink that escapes the disposable workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-repair-safety-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.md");
    await mkdir(workspace);
    await writeFile(outside, "untouched\n");
    await symlink(outside, join(workspace, "README.md"));
    await expect(assertRepairTargetSafe(workspace, join(workspace, "README.md"))).rejects.toThrow("escapes disposable workspace");
    await rm(root, { recursive: true, force: true });
  });

  it("permits apply only for an explicit approve decision", () => {
    expect(ownerDecisionPermitsApply(decision())).toBe(true);
    expect(ownerDecisionPermitsApply(decision({ decision: "reject" }))).toBe(false);
    expect(ownerDecisionPermitsApply(decision({ decision: "hold" }))).toBe(false);
    expect(ownerDecisionPermitsApply(decision({ decision: "continue" }))).toBe(false);
  });

  it("rejects stale packet hashes and unsafe or source branches", () => {
    const state = continuationState();
    expect(() => validateOwnerDecisionForContinuation(decision(), state, "OWNER-APPROVAL-1")).not.toThrow();
    expect(() => validateOwnerDecisionForContinuation(decision({ patch_diff_hash: "stale" }), state, "OWNER-APPROVAL-1")).toThrow("Stale owner decision");
    expect(() => validateOwnerDecisionForContinuation(decision({ target_branch_or_worktree: "main" }), state, "OWNER-APPROVAL-1")).toThrow("safe non-main");
    expect(() => validateOwnerDecisionForContinuation(decision({ target_branch_or_worktree: "develop" }), state, "OWNER-APPROVAL-1")).toThrow("source repository's current branch");
  });
});

function decision(override: Partial<OwnerDecision> = {}): OwnerDecision {
  return { decision_id: "d87c4eaa-d6b7-48c1-ae86-2e483c48dd78", decision: "approve", run_id: "OWNER-APPROVAL-1", patch_package_hash: "package", patch_diff_hash: "diff", target_mode: "controlled-worktree", target_branch_or_worktree: "runforge/owner-approval-1-demo", owner_note: "Approved.", created_at: "2026-07-11T11:26:14.340Z", ...override };
}

function continuationState(): ContinuationState {
  return { repo: "/factory", sourceBranch: "develop", disposable: "/tmp/disposable", controlled: "/tmp/controlled", dockerImage: "runforge:local", commands: [], timeoutMs: 1_000, patchPackageHash: "package", patchDiffHash: "diff", sourceBefore: { path: "/factory", head: "abc", status: "" } };
}
