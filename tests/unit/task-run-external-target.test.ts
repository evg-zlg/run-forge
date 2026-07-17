import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskRunHarness } from "../../src/run/task-run-harness.js";
import { assertExternalPathsOutsideTarget, assertExternalTaskPolicy } from "../../src/run/task-run-external-target.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external task-run target boundaries", () => {
  it("allows local execution only with explicit disposable-workspace authority", async () => {
    const repo = await tempRoot("runforge-external-target-");
    await expect(assertExternalTaskPolicy({ repo, runtime: "local", commands: ["node --version"] })).rejects.toThrow("disposable local workspace");
    await expect(assertExternalTaskPolicy({ repo, runtime: "local", commands: ["node --version"], allowDisposableLocal: true })).resolves.toBeUndefined();
  });
  it("rejects artifact and tmp paths inside the original repository", async () => {
    const repo = await tempRoot("runforge-external-target-");
    await expect(assertExternalPathsOutsideTarget(repo, [join(repo, "validation", "run")])).rejects.toThrow("must be outside --repo");
    await expect(assertExternalPathsOutsideTarget(repo, [join(repo, ".runforge-tmp")])).rejects.toThrow("must be outside --repo");
  });

  it("resolves symlinked ancestors before applying the containment check", async () => {
    const repo = await tempRoot("runforge-external-target-");
    const outside = await tempRoot("runforge-external-outside-");
    await mkdir(join(repo, "nested"));
    await symlink(join(repo, "nested"), join(outside, "linked-target"));

    await expect(assertExternalPathsOutsideTarget(repo, [join(outside, "linked-target", "run")])).rejects.toThrow("must be outside --repo");
  });

  it("fails before deleting an unsafe output path", async () => {
    const repo = await tempRoot("runforge-external-target-");
    const tmp = await tempRoot("runforge-external-tmp-");
    const unsafeOut = join(repo, "validation", "run");
    await mkdir(unsafeOut, { recursive: true });
    await writeFile(join(unsafeOut, "sentinel.txt"), "preserve me\n", "utf8");

    await expect(runTaskRunHarness({
      task: "unsafe path regression",
      out: unsafeOut,
      repo,
      tmpRoot: join(tmp, "workspace"),
      runtime: "docker",
      commands: ["node --version"],
      prepareRuntime: "none"
    })).rejects.toThrow("must be outside --repo");

    await expect(readFile(join(unsafeOut, "sentinel.txt"), "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails before deleting an unsafe tmp root", async () => {
    const repo = await tempRoot("runforge-external-target-");
    const outside = await tempRoot("runforge-external-outside-");
    const unsafeTmp = join(repo, ".runforge-workspace");
    await mkdir(unsafeTmp, { recursive: true });
    await writeFile(join(unsafeTmp, "sentinel.txt"), "preserve tmp\n", "utf8");

    await expect(runTaskRunHarness({
      task: "unsafe tmp regression",
      out: join(outside, "artifacts"),
      repo,
      tmpRoot: unsafeTmp,
      runtime: "docker",
      commands: ["node --version"],
      prepareRuntime: "none"
    })).rejects.toThrow("must be outside --repo");

    await expect(readFile(join(unsafeTmp, "sentinel.txt"), "utf8")).resolves.toBe("preserve tmp\n");
  });

  it("accepts sibling artifact and tmp roots", async () => {
    const repo = await tempRoot("runforge-external-target-");
    await expect(assertExternalPathsOutsideTarget(repo, [`${repo}-artifacts`, `${repo}-tmp`])).resolves.toBeUndefined();
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
