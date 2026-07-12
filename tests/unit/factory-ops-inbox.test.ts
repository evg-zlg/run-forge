import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFactoryOpsInbox } from "../../src/run/factory-ops-inbox.js";

describe("factory ops inbox", () => {
  it("records missing and non-git projects without aborting", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-inbox-")); const plain = join(root, "autokitaec"); await mkdir(plain);
    const result = await runFactoryOpsInbox({ repos: [plain, join(root, "missing")], out: join(root, "out"), now: new Date("2026-07-12T00:00:00Z") });
    expect(result).toMatchObject({ projectsInspected: 2, backlogSize: 0, targetUnchanged: true });
    expect(await readFile(join(root, "out", "projects", "autokitaec", "status.md"), "utf8")).toContain("not a Git worktree");
  });

  it("finds local RunForge branches and patch packages read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-inbox-repo-")); const repo = join(root, "demo"); await mkdir(join(repo, "validation", "runs", "r1", "patch-package"), { recursive: true });
    await writeFile(join(repo, "README.md"), "demo\n"); await writeFile(join(repo, "validation", "runs", "r1", "patch-package", "manifest.json"), "{}\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]); execFileSync("git", ["-C", repo, "branch", "runforge/demo"]);
    const before = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }); const out = join(root, "out");
    const result = await runFactoryOpsInbox({ repos: [repo], out, now: new Date("2026-07-12T00:00:00Z") });
    expect(result).toMatchObject({ branches: 1, patchPackages: 1, newTargetPrsCreated: 0, targetUnchanged: true });
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(before);
    expect(await readFile(join(out, "owner-inbox.md"), "utf8")).toContain("runforge/demo");
  });
});
