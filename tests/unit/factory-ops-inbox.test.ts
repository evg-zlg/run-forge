import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("uses GitHub PR history and live refs to find only genuinely unpaired branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-inbox-history-")); const repo = join(root, "demo"); const bin = join(root, "bin");
    await mkdir(repo); await mkdir(bin); await writeFile(join(repo, "README.md"), "demo\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/demo.git"]);
    execFileSync("git", ["-C", repo, "branch", "runforge/merged"]); execFileSync("git", ["-C", repo, "branch", "runforge/closed"]); execFileSync("git", ["-C", repo, "branch", "runforge/unpaired"]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/runforge/deleted", "HEAD"]);
    const gh = join(bin, "gh");
    await writeFile(gh, `#!/bin/sh
case " $* " in
  *" --state all "*) printf '%s\\n' '[{"number":1,"title":"merged","url":"https://github.com/example/demo/pull/1","isDraft":false,"headRefName":"runforge/merged","updatedAt":"2026-07-12T00:00:00Z","mergeStateStatus":"UNKNOWN","state":"MERGED","statusCheckRollup":[]},{"number":2,"title":"closed","url":"https://github.com/example/demo/pull/2","isDraft":false,"headRefName":"runforge/closed","updatedAt":"2026-07-12T00:00:00Z","mergeStateStatus":"UNKNOWN","state":"CLOSED","statusCheckRollup":[]}]' ;;
  *) printf '%s\\n' '[]' ;;
esac
`); await chmod(gh, 0o755);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      const out = join(root, "out"); const result = await runFactoryOpsInbox({ repos: [repo], out, now: new Date("2026-07-12T00:00:00Z") });
      expect(result).toMatchObject({ branches: 1, backlogSize: 0, targetUnchanged: true });
      const inbox = await readFile(join(out, "owner-inbox.md"), "utf8");
      expect(inbox).toContain("runforge/unpaired"); expect(inbox).not.toContain("runforge/merged"); expect(inbox).not.toContain("runforge/closed"); expect(inbox).not.toContain("runforge/deleted");
    } finally { process.env.PATH = oldPath; }
  });
});
