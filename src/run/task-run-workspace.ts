import { access, cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type WorkspaceLinkManifest = {
  schemaVersion: 1; kind: "workspace-link"; taskId: string; workspaceId: string;
  path: string; expectedTarget: string; createdAt: string;
};
export type WorkspaceLinkPreparation = {
  outcome: "workspace_ready"; classification: "absent" | "created" | "reused" | "repaired";
  path: string; expectedTarget: string | null; owned: boolean; manifest: string;
};
export class WorkspaceSetupError extends Error {
  readonly outcome = "workspace_setup_failed" as const;
  readonly code = "workspace_conflict_external" as const;
  readonly retryable = false as const;
  constructor(readonly details: { path: string; expectedTarget: string; actualTarget: string | null; owner: WorkspaceLinkManifest | null; quarantinePath?: string }) {
    super(`workspace_conflict_external: refusing to replace an externally owned workspace path: ${details.path}`);
    this.name = "WorkspaceSetupError";
  }
}

export async function copyTaskRunWorkspace(repoRoot: string, workspace: string, outPath: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await cp(repoRoot, workspace, {
    recursive: true,
    filter: (source) => {
      const path = relative(repoRoot, source);
      if (!path) return true;
      if (isSensitiveWorkspacePath(path)) return false;
      if (outPath && (path === outPath || path.startsWith(`${outPath}/`))) return false;
      const parts = path.split(/[\\/]/);
      if (parts.includes("node_modules")) return false;
      const first = parts[0];
      return !["node_modules", "dist", ".git", ".runforge", "artifacts", "runforge-artifacts"].includes(first!);
    }
  });
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => [".ssh", ".gnupg", ".kube", ".azure"].includes(part))) return true;
  if (parts.includes(".aws") && name === "credentials") return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  return [".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name);
}

export async function prepareUnpreparedExternalWorkspace(sourceRepo: string, workspace: string, workingDirectory = ".", identity?: { taskId: string; workspaceId: string }, hooks: { beforeOwnedPathMutation?: () => void | Promise<void> } = {}): Promise<WorkspaceLinkPreparation> {
  const executionRoot = resolve(workspace, workingDirectory), target = join(executionRoot, "node_modules");
  const manifestPath = join(executionRoot, ".runforge-workspace-link-owner.json");
  const owner = await readManifest(manifestPath), ownerState = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  const taskId = identity?.taskId ?? "unscoped-task", workspaceId = identity?.workspaceId ?? resolve(workspace);
  await mkdir(join(workspace, ".runforge-tmp"), { recursive: true });
  await mkdir(join(executionRoot, ".runforge-tmp"), { recursive: true });
  const dependenciesExist = await access(join(sourceRepo, workingDirectory, "node_modules")).then(() => true, () => false);
  if (!dependenciesExist) return { outcome: "workspace_ready", classification: "absent", path: target, expectedTarget: null, owned: false, manifest: manifestPath };
  const expectedTarget = "/source/node_modules", existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  const actualTarget = existing?.isSymbolicLink() ? await readlink(target) : null;
  if (existing && actualTarget === expectedTarget) {
    const owned = Boolean(owner && owner.taskId === taskId && owner.path === target && owner.expectedTarget === expectedTarget);
    if (!owned) throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget, owner });
    if (owner!.workspaceId !== workspaceId) await writeOwner(manifestPath, { ...owner!, workspaceId, createdAt: new Date().toISOString() });
    return { outcome: "workspace_ready", classification: "reused", path: target, expectedTarget, owned: true, manifest: manifestPath };
  }
  if (!existing && ownerState && (!owner || owner.taskId !== taskId || owner.path !== target || owner.expectedTarget !== expectedTarget)) {
    throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget, owner });
  }
  const taskOwned = Boolean(owner && owner.taskId === taskId && owner.path === target && owner.expectedTarget === expectedTarget);
  if (existing && !taskOwned) throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget, owner });
  const nextOwner: WorkspaceLinkManifest = { schemaVersion: 1, kind: "workspace-link", taskId, workspaceId, path: target, expectedTarget, createdAt: new Date().toISOString() };
  let quarantine: string | null = null;
  if (existing) {
    await hooks.beforeOwnedPathMutation?.();
    quarantine = join(dirname(target), `.node_modules.${randomUUID()}.runforge-quarantine`);
    try { await rename(target, quarantine); }
    catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw await workspaceConflict(target, expectedTarget, manifestPath);
      throw error;
    }
    const quarantined = await lstat(quarantine).catch(() => null), quarantinedTarget = quarantined?.isSymbolicLink() ? await readlink(quarantine) : null;
    const currentOwner = await readManifest(manifestPath), stillOwned = Boolean(quarantined?.isSymbolicLink() && quarantinedTarget === actualTarget && currentOwner && currentOwner.taskId === taskId && currentOwner.path === target && currentOwner.expectedTarget === expectedTarget);
    if (!stillOwned) {
      await restoreQuarantine(quarantine, target);
      throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget: quarantinedTarget, owner: currentOwner, ...(await pathExists(quarantine) ? { quarantinePath: quarantine } : {}) });
    }
  }
  try { await symlink(expectedTarget, target, "dir"); }
  catch (error) {
    if (quarantine) await restoreQuarantine(quarantine, target);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw await workspaceConflict(target, expectedTarget, manifestPath, quarantine ?? undefined);
    throw error;
  }
  if (quarantine) await rm(quarantine, { force: true });
  await writeOwner(manifestPath, nextOwner);
  return { outcome: "workspace_ready", classification: existing ? "repaired" : "created", path: target, expectedTarget, owned: true, manifest: manifestPath };
}

async function readManifest(path: string): Promise<WorkspaceLinkManifest | null> { try { const value = JSON.parse(await readFile(path, "utf8")) as WorkspaceLinkManifest; return value?.schemaVersion === 1 && value.kind === "workspace-link" ? value : null; } catch { return null; } }
async function writeOwner(path: string, value: WorkspaceLinkManifest): Promise<void> { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
async function pathExists(path: string): Promise<boolean> { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error)); }
async function restoreQuarantine(quarantine: string, target: string): Promise<void> { if (!(await pathExists(target))) await rename(quarantine, target).catch(() => undefined); }
async function workspaceConflict(target: string, expectedTarget: string, manifestPath: string, quarantinePath?: string): Promise<WorkspaceSetupError> { return new WorkspaceSetupError({ path: target, expectedTarget, actualTarget: await readlink(target).catch(() => null), owner: await readManifest(manifestPath), ...(quarantinePath && await pathExists(quarantinePath) ? { quarantinePath } : {}) }); }

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
