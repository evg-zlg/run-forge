import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRepairTargetSafe, reviewPatchText, validateExternalExecutionModes } from "../../src/run/external-execution.js";

const valid = {
  task: "repair",
  out: "validation/runs/EXTERNAL-EXECUTION-TEST",
  repo: "/external/repo",
  runtime: "docker",
  dockerImage: "runforge:local",
  prepareRuntime: "explicit",
  repairMode: "disposable",
  approvalMode: "await-owner",
  applyMode: "controlled-worktree",
  commands: [],
  timeoutMs: 1_000
};

describe("external execution gates", () => {
  it("accepts the owner-gated disposable contour", () => {
    expect(() => validateExternalExecutionModes(valid)).not.toThrow();
  });

  it.each([
    [{ runtime: "local" }, "--runtime docker"],
    [{ prepareRuntime: "none" }, "--prepare-runtime explicit"],
    [{ repairMode: "in-place" }, "only 'disposable'"],
    [{ approvalMode: "automatic" }, "Unsupported --approval-mode"],
    [{ applyMode: "main" }, "only 'controlled-worktree'"]
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
});
