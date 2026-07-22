import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTaskRunWorkspace, prepareUnpreparedExternalWorkspace, WorkspaceSetupError } from "../../src/run/task-run-workspace.js";

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

describe("external workspace link lifecycle", () => {
  it("excludes nested dependencies from the copy and prepares the expected link repeatedly", async () => {
    const { source, workspace } = await fixture("nested");
    await copyTaskRunWorkspace(source, workspace, "");
    await expect(lstat(join(workspace, "frontend", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const identity = { taskId: "TASK-1", workspaceId: "attempt-1" };
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, "frontend", identity)).resolves.toMatchObject({ classification: "created", owned: true });
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, "frontend", identity)).resolves.toMatchObject({ classification: "reused", owned: true });
    expect(await readlink(join(workspace, "frontend", "node_modules"))).toBe("/source/node_modules");
    expect(await readFile(join(source, "frontend", "node_modules", "fixture.txt"), "utf8")).toBe("source dependency\n");
  });

  it.each(["wrong", "broken"] as const)("atomically repairs a %s task-owned link from a stale generation", async (kind) => {
    const { source, workspace, root } = await fixture(kind);
    const first = { taskId: "TASK-OWNED", workspaceId: "generation-1" };
    await prepareUnpreparedExternalWorkspace(source, workspace, ".", first);
    const target = join(workspace, "node_modules");
    await rm(target);
    await symlink(kind === "broken" ? join(root, "missing") : join(root, "wrong"), target, "dir");
    const repaired = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { ...first, workspaceId: "generation-2" });
    expect(repaired).toMatchObject({ classification: "repaired", owned: true, expectedTarget: "/source/node_modules" });
    expect(await readlink(target)).toBe("/source/node_modules");
    expect(JSON.parse(await readFile(repaired.manifest, "utf8"))).toMatchObject({ taskId: "TASK-OWNED", workspaceId: "generation-2", expectedTarget: "/source/node_modules" });
  });

  it("preserves an externally owned symlink and returns a typed workspace conflict", async () => {
    const { source, workspace, root } = await fixture("external");
    const target = join(workspace, "node_modules"), external = join(root, "external-dependencies");
    await mkdir(external); await symlink(external, target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-2", workspaceId: "attempt-1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", retryable: false, details: { path: target, expectedTarget: "/source/node_modules", actualTarget: external, owner: null } });
    expect(await readlink(target)).toBe(external);
  });

  it("does not claim or reuse an unowned symlink even when it points at the expected target", async () => {
    const { source, workspace } = await fixture("unowned-expected");
    const target = join(workspace, "node_modules"); await symlink("/source/node_modules", target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-3", workspaceId: "attempt-1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", details: { path: target, expectedTarget: "/source/node_modules", actualTarget: "/source/node_modules", owner: null } });
    expect(await readlink(target)).toBe("/source/node_modules");
    await expect(access(join(workspace, ".runforge-workspace-link-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines and restores an external directory swapped in after ownership validation", async () => {
    const { source, workspace } = await fixture("toctou");
    const identity = { taskId: "TASK-RACE", workspaceId: "generation-1" }, target = join(workspace, "node_modules");
    await prepareUnpreparedExternalWorkspace(source, workspace, ".", identity);
    await rm(target); await symlink(join(workspace, "stale-owned-target"), target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", identity, { beforeOwnedPathMutation: async () => {
      await rm(target); await mkdir(target); await writeFile(join(target, "external.txt"), "preserve me\n");
    } }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", details: { path: target, expectedTarget: "/source/node_modules", actualTarget: null } });
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await readFile(join(target, "external.txt"), "utf8")).toBe("preserve me\n");
  });

  it("isolates two task-owned workspaces for the same project and working directory", async () => {
    const { source, root } = await fixture("parallel");
    const one = join(root, "workspace-one"), two = join(root, "workspace-two"); await mkdir(one); await mkdir(two);
    const [first, second] = await Promise.all([
      prepareUnpreparedExternalWorkspace(source, one, ".", { taskId: "TASK-A", workspaceId: "attempt-1" }),
      prepareUnpreparedExternalWorkspace(source, two, ".", { taskId: "TASK-B", workspaceId: "attempt-1" }),
    ]);
    expect([first.classification, second.classification]).toEqual(["created", "created"]);
    expect(await readlink(join(one, "node_modules"))).toBe("/source/node_modules");
    expect(await readlink(join(two, "node_modules"))).toBe("/source/node_modules");
  });
});

async function fixture(name: string): Promise<{ root: string; source: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), `runforge-workspace-${name}-`)); roots.push(root);
  const source = join(root, "source"), workspace = join(root, "workspace"); await mkdir(source); await mkdir(workspace);
  const dependencyRoot = name === "nested" ? join(source, "frontend", "node_modules") : join(source, "node_modules");
  await mkdir(dependencyRoot, { recursive: true }); await writeFile(join(dependencyRoot, "fixture.txt"), "source dependency\n");
  await writeFile(join(source, "README.md"), "immutable source\n");
  return { root, source, workspace };
}
