import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTaskRunWorkspace } from "../../src/run/task-run-workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("task-run workspace secret filtering", () => {
  it("excludes secret-bearing files at any depth while preserving examples", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-copy-source-"))) - 1]!;
    const target = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-copy-target-"))) - 1]!;
    for (const file of ["config/.env", ".aws/credentials", "packages/app/.npmrc", "home/.ssh/id_rsa"]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "sensitive\n");
    }
    await writeFile(join(root, ".env.example"), "SAFE=example\n");
    await mkdir(join(root, "src", "credentials"), { recursive: true });
    await writeFile(join(root, "src", "credentials", "index.ts"), "export const safe = true;\n");
    await mkdir(join(root, "packages", "gcloud"), { recursive: true });
    await writeFile(join(root, "packages", "gcloud", "index.ts"), "export const safe = true;\n");
    await writeFile(join(root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    await copyTaskRunWorkspace(root, target, "");
    for (const file of ["config/.env", ".aws/credentials", "packages/app/.npmrc", "home/.ssh/id_rsa"]) {
      await expect(access(join(target, file))).rejects.toThrow();
    }
    expect(await readFile(join(target, ".env.example"), "utf8")).toBe("SAFE=example\n");
    expect(await readFile(join(target, "src", "credentials", "index.ts"), "utf8")).toContain("safe");
    expect(await readFile(join(target, "packages", "gcloud", "index.ts"), "utf8")).toContain("safe");
    expect(await readFile(join(target, ".yarnrc.yml"), "utf8")).toContain("nodeLinker");
  });
});
