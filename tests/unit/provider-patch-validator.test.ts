import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateProviderPatch } from "../../src/run/provider-patch-validator.js";

const execFileAsync = promisify(execFile);

describe("provider patch validator", () => {
  it("accepts a scoped unified diff that dry-runs cleanly", async () => {
    const repo = await createRepo();
    const result = await validateProviderPatch({ repoPath: repo, patch: patchFor("state.txt", "bad", "good") });
    expect(result).toMatchObject({
      accepted: true,
      filesChanged: ["state.txt"],
      checks: { dryRunApply: "passed" }
    });
  });

  it.each([
    ["forbidden .env patch", patchFor(".env", "bad", "good"), /forbidden path/],
    ["path traversal", patchFor("../escape.txt", "bad", "good"), /outside repo scope/],
    ["absolute path", patchFor("/tmp/escape.txt", "bad", "good"), /absolute path/],
    ["malformed diff", "diff --git a/state.txt b/state.txt\n--- a/state.txt\n", /malformed diff/],
    ["empty patch", "", /did not contain a patch/]
  ])("rejects %s", async (_name, patch, reason) => {
    const repo = await createRepo();
    const result = await validateProviderPatch({ repoPath: repo, patch });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toMatch(reason);
  });

  it("rejects too many changed files", async () => {
    const repo = await createRepo(["one.txt", "two.txt"]);
    const patch = `${patchFor("one.txt", "bad", "good")}${patchFor("two.txt", "bad", "good")}`;
    const result = await validateProviderPatch({ repoPath: repo, patch, contract: { maxFilesChanged: 1 } });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("exceeding maxFilesChanged 1");
  });

  it("rejects too large patches", async () => {
    const repo = await createRepo();
    const result = await validateProviderPatch({ repoPath: repo, patch: patchFor("state.txt", "bad", "good"), contract: { maxPatchBytes: 10 } });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("exceeds maxPatchBytes 10");
  });

  it("rejects patches outside allowedPaths", async () => {
    const repo = await createRepo();
    const result = await validateProviderPatch({ repoPath: repo, patch: patchFor("state.txt", "bad", "good"), contract: { allowedPaths: ["src/**"] } });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("outside allowedPaths");
  });

  it("rejects patches that fail dry-run apply", async () => {
    const repo = await createRepo();
    const result = await validateProviderPatch({ repoPath: repo, patch: patchFor("state.txt", "missing", "good") });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("failed dry-run apply");
  });

  it("rejects unsupported binary diffs and mode changes", async () => {
    const repo = await createRepo();
    const patch = [
      "diff --git a/state.txt b/state.txt",
      "old mode 100644",
      "new mode 100755",
      "Binary files a/state.txt and b/state.txt differ",
      ""
    ].join("\n");
    const result = await validateProviderPatch({ repoPath: repo, patch });
    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toMatch(/binary diffs|file mode/);
  });
});

async function createRepo(files = ["state.txt"]): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-provider-validator-"));
  for (const file of files) await writeFile(join(repo, file), "bad\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Test", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

function patchFor(file: string, before: string, after: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}
