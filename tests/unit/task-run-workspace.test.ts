import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPreparedExternalWorkspace, copyTaskRunWorkspace, prepareUnpreparedExternalWorkspace, WorkspaceSetupError } from "../../src/run/task-run-workspace.js";

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
  it("excludes nested dependencies from the copy and prepares an isolated dependency copy repeatedly", async () => {
    const { source, workspace } = await fixture("nested");
    await copyTaskRunWorkspace(source, workspace, "");
    await expect(lstat(join(workspace, "frontend", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const identity = { taskId: "TASK-1", workspaceId: "attempt-1" };
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, "frontend", identity)).resolves.toMatchObject({ classification: "created", owned: true });
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, "frontend", identity)).resolves.toMatchObject({ classification: "reused", owned: true });
    await writeFile(join(workspace, "frontend", "node_modules", "fixture.txt"), "workspace dependency\n");
    expect(await readFile(join(source, "frontend", "node_modules", "fixture.txt"), "utf8")).toBe("source dependency\n");
  });

  it.each(["wrong", "broken"] as const)("atomically repairs a %s task-owned link from a stale generation", async (kind) => {
    const { source, workspace, root } = await fixture(kind);
    const first = { taskId: "TASK-OWNED", workspaceId: "generation-1" };
    await prepareUnpreparedExternalWorkspace(source, workspace, ".", first);
    const target = join(workspace, "node_modules");
    await rm(target, { recursive: true });
    await symlink(kind === "broken" ? join(root, "missing") : join(root, "wrong"), target, "dir");
    const repaired = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { ...first, workspaceId: "generation-2" });
    expect(repaired).toMatchObject({ classification: "repaired", owned: true, expectedTarget: expect.stringContaining("runforge-dependencies-") });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "fixture.txt"), "utf8")).toBe("source dependency\n");
    expect(JSON.parse(await readFile(repaired.manifest, "utf8"))).toMatchObject({ taskId: "TASK-OWNED", workspaceId: "generation-2", expectedTarget: expect.stringContaining("runforge-dependencies-") });
  });

  it("preserves an externally owned symlink and returns a typed workspace conflict", async () => {
    const { source, workspace, root } = await fixture("external");
    const target = join(workspace, "node_modules"), external = join(root, "external-dependencies");
    await mkdir(external); await symlink(external, target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-2", workspaceId: "attempt-1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", retryable: false, details: { path: target, expectedTarget: "", actualTarget: external, owner: null } });
    expect(await readlink(target)).toBe(external);
  });

  it("does not claim or reuse an unowned symlink even when it points at the expected target", async () => {
    const { source, workspace } = await fixture("unowned-expected");
    const target = join(workspace, "node_modules"); await symlink(join(source, "node_modules"), target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-3", workspaceId: "attempt-1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", details: { path: target, expectedTarget: "", actualTarget: join(source, "node_modules"), owner: null } });
    expect(await readlink(target)).toBe(join(source, "node_modules"));
    await expect(access(join(workspace, ".runforge-workspace-link-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not trust a forged manifest to reuse or delete a matching temporary directory", async () => {
    const { source, workspace, root } = await fixture("forged-owner"); const target = join(workspace, "node_modules"), external = join(root, "runforge-dependencies-forged-Ab12Cd"); await mkdir(external); await writeFile(join(external, "sentinel"), "preserve\n"); await symlink(external, target, "dir"); await writeFile(join(workspace, ".runforge-workspace-link-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "workspace-link", taskId: "TASK-FORGED", workspaceId: "attempt-1", path: target, expectedTarget: external, createdAt: new Date().toISOString() }));
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-FORGED", workspaceId: "attempt-1" })).rejects.toBeInstanceOf(WorkspaceSetupError);
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("preserve\n");
  });

  it("does not let one registered workspace claim or clean another workspace's dependency directory", async () => {
    const { source, root } = await fixture("cross-capability"), one = join(root, "one"), two = join(root, "two"); await mkdir(one); await mkdir(two); const identity = { taskId: "TASK-CROSS", workspaceId: "attempt-1" };
    const first = await prepareUnpreparedExternalWorkspace(source, one, ".", identity), second = await prepareUnpreparedExternalWorkspace(source, two, ".", identity); await writeFile(join(second.expectedTarget!, "sentinel"), "preserve\n"); await rm(join(one, "node_modules")); await symlink(second.expectedTarget!, join(one, "node_modules"), "dir"); await writeFile(first.manifest, JSON.stringify({ schemaVersion: 1, kind: "workspace-link", taskId: identity.taskId, workspaceId: identity.workspaceId, path: join(one, "node_modules"), expectedTarget: second.expectedTarget, createdAt: new Date().toISOString() }));
    await expect(prepareUnpreparedExternalWorkspace(source, one, ".", identity)).rejects.toBeInstanceOf(WorkspaceSetupError); await cleanupPreparedExternalWorkspace(one); expect(await readFile(join(second.expectedTarget!, "sentinel"), "utf8")).toBe("preserve\n");
  });

  it("does not use an external temporary-root symlink", async () => {
    const { source, workspace, root } = await fixture("temporary-root"); const external = join(root, "external-temp"); await mkdir(external); await writeFile(join(external, "sentinel"), "preserve\n"); await symlink(external, join(workspace, ".runforge-tmp"), "dir");
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-TEMP", workspaceId: "attempt-1" })).resolves.toMatchObject({ classification: "created", owned: true });
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("preserve\n"); await expect(access(join(external, "task-temp-node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes and removes a private dependency lease when preparation fails after allocation", async () => {
    const { source, workspace } = await fixture("preparation-failure"); let allocated: string | undefined;
    await expect(prepareUnpreparedExternalWorkspace(source, workspace, ".", { taskId: "TASK-FAIL", workspaceId: "attempt-1" }, {
      onPrivateDependenciesCreated: (lease) => { allocated = lease.path; throw new Error("injected preparation failure"); },
    })).rejects.toThrow("injected preparation failure");
    expect(allocated).toContain("runforge-dependencies-task-fail-");
    await expect(access(allocated!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(workspace, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines and restores an external directory swapped in after ownership validation", async () => {
    const { source, workspace } = await fixture("toctou");
    const identity = { taskId: "TASK-RACE", workspaceId: "generation-1" }, target = join(workspace, "node_modules");
    await prepareUnpreparedExternalWorkspace(source, workspace, ".", identity);
    await rm(target, { recursive: true }); await symlink(join(workspace, "stale-owned-target"), target, "dir");
    const failure = await prepareUnpreparedExternalWorkspace(source, workspace, ".", identity, { beforeOwnedPathMutation: async () => {
      await rm(target); await mkdir(target); await writeFile(join(target, "external.txt"), "preserve me\n");
    } }).catch((error) => error);
    expect(failure).toBeInstanceOf(WorkspaceSetupError);
    expect(failure).toMatchObject({ code: "workspace_conflict_external", outcome: "workspace_setup_failed", details: { path: target, expectedTarget: expect.stringContaining("runforge-dependencies-"), actualTarget: null } });
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
    await writeFile(join(one, "node_modules", "fixture.txt"), "one\n");
    expect(await readFile(join(two, "node_modules", "fixture.txt"), "utf8")).toBe("source dependency\n");
    expect(await readFile(join(source, "node_modules", "fixture.txt"), "utf8")).toBe("source dependency\n");
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
