import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { discoverProject } from "../../src/run/project-discovery.js";

describe("project discovery", () => {
  it("prefers the checked-out main branch over a stale remote HEAD", async () => {
    const repo = await mkdtemp(join(tmpdir(), "runforge-default-branch-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "cli", scripts: { test: "node --test" } }));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "main"]);
    execFileSync("git", ["-C", repo, "branch", "codex/stale-default"]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/codex/stale-default", "refs/heads/codex/stale-default"]);
    execFileSync("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/codex/stale-default"]);
    expect((await discoverProject(repo)).default_branch).toBe("main");
  });
});
