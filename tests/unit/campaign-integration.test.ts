import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignIntegration } from "../../src/control-plane/campaign-integration.js";

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runforge-campaign-integration-")); cleanup.push(root);
  const repo = join(root, "repo"), state = join(root, "state"), patches = join(root, "patches");
  await mkdir(repo); await mkdir(state); await mkdir(patches);
  await exec("git", ["init", "-q", repo]);
  await writeFile(join(repo, "src.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "src.txt"]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const integration = new CampaignIntegration();
  const worktree = await integration.ensureCampaignWorktree({ sourceRepository: repo, stateRoot: state, campaignId: "cmp_v1_123456789012345678901234", baseSha });
  return { root, repo, state, patches, baseSha, integration, worktree };
}

function patch(path: string, body: string): string { return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", `+${body}`, ""].join("\n"); }

describe("campaign integration", () => {
  it("creates and idempotently reopens a dedicated branch worktree", async () => {
    const f = await fixture();
    const reopened = await f.integration.ensureCampaignWorktree({ sourceRepository: f.repo, stateRoot: f.state, campaignId: "cmp_v1_123456789012345678901234", baseSha: f.baseSha });
    expect(reopened).toMatchObject({ worktreeRoot: f.worktree.worktreeRoot, headSha: f.baseSha, branch: "runforge/campaign/cmp_v1_123456789012345678901234" });
    expect((await exec("git", ["-C", f.repo, "status", "--porcelain"])).stdout).toBe("");
  });

  it("applies an allowed patch and commits metadata only", async () => {
    const f = await fixture(), patchPath = join(f.patches, "child.patch"); await writeFile(patchPath, patch("src/new.ts", "export const value = 1;"));
    const result = await f.integration.integrateChildPatch({ stateRoot: f.state, worktreeRoot: f.worktree.worktreeRoot, patchRoot: f.patches, patchPath, allowedScopes: ["src"], nodeId: "implement" });
    expect(result).toMatchObject({ status: "integrated", changedFiles: ["src/new.ts"] });
    expect(JSON.stringify(result)).not.toContain("export const value");
    expect(await readFile(join(f.worktree.worktreeRoot, "src/new.ts"), "utf8")).toContain("value");
  });

  it("rejects an out-of-scope patch before apply", async () => {
    const f = await fixture(), patchPath = join(f.patches, "outside.patch"); await writeFile(patchPath, patch("docs/new.md", "no"));
    await expect(f.integration.integrateChildPatch({ stateRoot: f.state, worktreeRoot: f.worktree.worktreeRoot, patchRoot: f.patches, patchPath, allowedScopes: ["src"], nodeId: "x" })).rejects.toMatchObject({ code: "PATCH_SCOPE_VIOLATION" });
    expect(await f.integration.currentCampaignHead({ stateRoot: f.state, worktreeRoot: f.worktree.worktreeRoot })).toBe(f.baseSha);
  });

  it("rejects traversal, symlink and oversize patch inputs", async () => {
    const f = await fixture(), real = join(f.patches, "real.patch"), link = join(f.patches, "link.patch"); await writeFile(real, patch("../escape", "no")); await symlink(real, link);
    const base = { stateRoot: f.state, worktreeRoot: f.worktree.worktreeRoot, patchRoot: f.patches, allowedScopes: ["src"], nodeId: "x" };
    await expect(f.integration.integrateChildPatch({ ...base, patchPath: link })).rejects.toMatchObject({ code: "PATCH_NOT_REGULAR" });
    await expect(f.integration.integrateChildPatch({ ...base, patchPath: real })).rejects.toMatchObject({ code: "PATCH_SCOPE_VIOLATION" });
    await writeFile(real, "x".repeat(100));
    await expect(f.integration.integrateChildPatch({ ...base, patchPath: real, maxPatchBytes: 20 })).rejects.toMatchObject({ code: "PATCH_OVERSIZE" });
  });

  it("cleans the dedicated worktree after an apply failure", async () => {
    const f = await fixture(), patchPath = join(f.patches, "bad.patch"); await writeFile(patchPath, ["diff --git a/src.txt b/src.txt", "--- a/src.txt", "+++ b/src.txt", "@@ -1 +1 @@", "-not-the-base", "+changed", ""].join("\n"));
    await expect(f.integration.integrateChildPatch({ stateRoot: f.state, worktreeRoot: f.worktree.worktreeRoot, patchRoot: f.patches, patchPath, allowedScopes: ["src.txt"], nodeId: "x" })).rejects.toMatchObject({ code: "PATCH_APPLY_FAILED" });
    expect((await exec("git", ["-C", f.worktree.worktreeRoot, "status", "--porcelain"])).stdout).toBe("");
    expect(await readFile(join(f.worktree.worktreeRoot, "src.txt"), "utf8")).toBe("base\n");
  });
});
