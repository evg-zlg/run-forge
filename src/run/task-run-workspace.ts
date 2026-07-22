import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export type WorkspaceLinkManifest = {
  schemaVersion: 1; kind: "workspace-link"; taskId: string; workspaceId: string;
  path: string; expectedTarget: string; createdAt: string;
};
export type WorkspaceLinkPreparation = {
  outcome: "workspace_ready"; classification: "absent" | "created" | "reused" | "repaired";
  path: string; expectedTarget: string | null; owned: boolean; manifest: string;
};
const privateDependencyCapabilities = new Map<string, { workspaceRoot: string; manifestPath: string; taskId: string }>();
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
  const canonicalExecutionRoot = await verifiedExecutionRoot(executionRoot, target, owner);
  const sourceDependenciesPath = resolve(sourceRepo, workingDirectory, "node_modules");
  const dependenciesExist = await access(sourceDependenciesPath).then(() => true, () => false);
  if (!dependenciesExist) return { outcome: "workspace_ready", classification: "absent", path: target, expectedTarget: null, owned: false, manifest: manifestPath };
  const expectedTarget = owner?.expectedTarget ?? "", existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  const actualTarget = existing?.isSymbolicLink() ? await readlink(target) : null;
  const capability = privateDependencyCapabilities.get(expectedTarget);
  const owned = Boolean(owner && owner.taskId === taskId && owner.path === target && owner.expectedTarget === expectedTarget && capability?.workspaceRoot === canonicalExecutionRoot && capability.manifestPath === manifestPath && capability.taskId === taskId);
  const privateReady = expectedTarget ? owned && await trustedPrivateDirectory(expectedTarget) : false;
  if (existing?.isSymbolicLink() && linkTargetMatches(target, actualTarget, expectedTarget) && owned && privateReady) {
    if (owner!.workspaceId !== workspaceId) await writeOwner(manifestPath, { ...owner!, workspaceId, createdAt: new Date().toISOString() });
    return { outcome: "workspace_ready", classification: "reused", path: target, expectedTarget, owned: true, manifest: manifestPath };
  }
  const taskOwned = owned;
  if (existing && !taskOwned) throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget, owner });
  const privateDependenciesPath = await mkdtemp(join(tmpdir(), `runforge-dependencies-${taskRunSlug(taskId)}-`));
  const nextOwner: WorkspaceLinkManifest = { schemaVersion: 1, kind: "workspace-link", taskId, workspaceId, path: target, expectedTarget: privateDependenciesPath, createdAt: new Date().toISOString() };
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
    const currentOwner = await readManifest(manifestPath), stillOwned = Boolean(quarantined?.isSymbolicLink() && quarantinedTarget === actualTarget && currentOwner && currentOwner.taskId === taskId && currentOwner.path === target);
    if (!stillOwned) {
      await restoreQuarantine(quarantine, target);
      throw new WorkspaceSetupError({ path: target, expectedTarget, actualTarget: quarantinedTarget, owner: currentOwner, ...(await pathExists(quarantine) ? { quarantinePath: quarantine } : {}) });
    }
  }
  try { await cp(sourceDependenciesPath, privateDependenciesPath, { recursive: true, dereference: true }); await symlink(privateDependenciesPath, target, "dir"); }
  catch (error) {
    if (quarantine) await restoreQuarantine(quarantine, target);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw await workspaceConflict(target, expectedTarget, manifestPath, quarantine ?? undefined);
    throw error;
  }
  if (quarantine) await rm(quarantine, { force: true }); privateDependencyCapabilities.set(privateDependenciesPath, { workspaceRoot: canonicalExecutionRoot, manifestPath, taskId });
  await writeOwner(manifestPath, nextOwner);
  return { outcome: "workspace_ready", classification: existing ? "repaired" : "created", path: target, expectedTarget: privateDependenciesPath, owned: true, manifest: manifestPath };
}

async function readManifest(path: string): Promise<WorkspaceLinkManifest | null> { try { const value = JSON.parse(await readFile(path, "utf8")) as WorkspaceLinkManifest; return value?.schemaVersion === 1 && value.kind === "workspace-link" ? value : null; } catch { return null; } }
async function writeOwner(path: string, value: WorkspaceLinkManifest): Promise<void> { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
async function pathExists(path: string): Promise<boolean> { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error)); }
async function restoreQuarantine(quarantine: string, target: string): Promise<void> { if (!(await pathExists(target))) await rename(quarantine, target).catch(() => undefined); }
async function workspaceConflict(target: string, expectedTarget: string, manifestPath: string, quarantinePath?: string): Promise<WorkspaceSetupError> { return new WorkspaceSetupError({ path: target, expectedTarget, actualTarget: await readlink(target).catch(() => null), owner: await readManifest(manifestPath), ...(quarantinePath && await pathExists(quarantinePath) ? { quarantinePath } : {}) }); }
async function verifiedExecutionRoot(executionRoot: string, target: string, owner: WorkspaceLinkManifest | null): Promise<string> { await mkdir(executionRoot, { recursive: true }); const state = await lstat(executionRoot), canonical = await realpath(executionRoot); if (!state.isDirectory() || state.isSymbolicLink()) throw new WorkspaceSetupError({ path: executionRoot, expectedTarget: executionRoot, actualTarget: state.isSymbolicLink() ? await readlink(executionRoot).catch(() => null) : null, owner }); return canonical; }
async function trustedPrivateDirectory(path: string): Promise<boolean> { const canonicalTemp = await realpath(tmpdir()).catch(() => ""), canonical = await realpath(path).catch(() => ""); return Boolean(canonicalTemp && canonical && dirname(canonical) === canonicalTemp && /^runforge-dependencies-[a-z0-9-]+[A-Za-z0-9]+$/.test(canonical.split("/").at(-1) ?? "") && (await lstat(canonical)).isDirectory()); }
export async function cleanupPreparedExternalWorkspace(workspace: string, workingDirectory = "."): Promise<void> { const executionRoot = resolve(workspace, workingDirectory), manifestPath = join(executionRoot, ".runforge-workspace-link-owner.json"), manifest = await readManifest(manifestPath); if (!manifest) return; const capability = privateDependencyCapabilities.get(manifest.expectedTarget), target = join(executionRoot, "node_modules"), actualTarget = await readlink(target).catch(() => null), canonicalRoot = await realpath(executionRoot).catch(() => ""); if (capability && capability.workspaceRoot === canonicalRoot && capability.manifestPath === manifestPath && capability.taskId === manifest.taskId && linkTargetMatches(target, actualTarget, manifest.expectedTarget) && await trustedPrivateDirectory(manifest.expectedTarget)) { await rm(manifest.expectedTarget, { recursive: true, force: true }); privateDependencyCapabilities.delete(manifest.expectedTarget); } }

function linkTargetMatches(linkPath: string, actualTarget: string | null, expectedTarget: string): boolean {
  if (!actualTarget) return false;
  if (actualTarget === expectedTarget) return true;
  return resolve(dirname(linkPath), actualTarget) === expectedTarget;
}
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); }

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
