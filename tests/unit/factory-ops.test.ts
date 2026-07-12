import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFactoryOps } from "../../src/run/factory-ops.js";

describe("factory ops", () => {
  it("discovers bounded candidates and preserves the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-ops-"));
    const repo = join(root, "repo"); await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "note.md"), "TODO document the safe command\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const registry = join(root, "projects.json"); const profiles = join(root, "profiles.json"); const out = join(root, "out");
    await writeFile(registry, JSON.stringify({ demo: { path: repo, risk: "test", default_profile: "read-only" } }));
    await writeFile(profiles, JSON.stringify({ "read-only": { publication_permission: "none" } }));
    const result = await runFactoryOps({ project: "demo", batchSize: 2, out, registry, profiles });
    expect(result).toMatchObject({ candidates: 1, selected: 1, targetUnchanged: true });
    expect(await readFile(join(out, "owner-inbox.md"), "utf8")).toContain("Owner inbox");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });
});
