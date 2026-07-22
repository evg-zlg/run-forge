import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceLinkManifest = {
  schemaVersion: 1; kind: "workspace-link"; taskId: string; workspaceId: string;
  path: string; expectedTarget: string; createdAt: string;
};
export type WorkspaceLinkPreparation = {
  outcome: "workspace_ready"; classification: "absent" | "created" | "reused" | "repaired";
  path: string; expectedTarget: string | null; owned: boolean; manifest: string;
};
export type PrivateDependencyLease = { readonly path: string; readonly token: string };
const privateDependencyCapabilities = new Map<string, { workspaceRoot: string; manifestPath: string; taskId: string; token: string }>();
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

/** Materializes an independent Git object database around an existing disposable source copy. */
export async function materializeAutonomousGitSnapshot(sourceRepository: string, workspace: string, expectedSha: string): Promise<void> {
  const source = await realpath(sourceRepository), staging = await mkdtemp(join(dirname(workspace), ".runforge-validation-git-")), bare = join(staging, "repository.git");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
  const git = (args: string[], cwd = workspace) => execFileAsync("git", args, { cwd, env, maxBuffer: 4_000_000 });
  try {
    await rm(join(workspace, ".git"), { recursive: true, force: true });
    await git(["clone", "--quiet", "--bare", "--no-local", "--no-hardlinks", "--depth", "1", "--single-branch", source, bare], dirname(workspace));
    await rename(bare, join(workspace, ".git"));
    await git(["config", "core.bare", "false"]); await git(["config", "core.worktree", ".."]).catch(() => undefined);
    await git(["remote", "remove", "origin"]).catch(() => undefined); await git(["config", "core.hooksPath", "/dev/null"]); await git(["config", "credential.helper", ""]); await git(["config", "protocol.file.allow", "never"]);
    await writeFile(join(workspace, ".git", "info", "exclude"), ["node_modules/", "**/node_modules/", ".runforge-corepack/", "**/.runforge-corepack/", ".runforge-tmp/", "**/.runforge-tmp/", ".runforge-workspace-link-owner.json", "**/.runforge-workspace-link-owner.json", ""].join("\n"), "utf8");
    await git(["cat-file", "-e", `${expectedSha}^{commit}`]); await git(["update-ref", "refs/heads/runforge-validation-snapshot", expectedSha]); await git(["symbolic-ref", "HEAD", "refs/heads/runforge-validation-snapshot"]); await git(["reset", "--quiet", "--hard", expectedSha]); await git(["clean", "-ffdx"]);
    const [{ stdout: head }, { stdout: status }, { stdout: commonDir }] = await Promise.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain=v1", "-uall"]), git(["rev-parse", "--git-common-dir"])]);
    if (head.trim() !== expectedSha || status.trim() || resolve(workspace, commonDir.trim()) !== join(workspace, ".git") || await access(join(workspace, ".git", "objects", "info", "alternates")).then(() => true, () => false)) throw new Error("Autonomous validation Git snapshot verification failed.");
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => [".ssh", ".gnupg", ".kube", ".azure"].includes(part))) return true;
  if (parts.includes(".aws") && name === "credentials") return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  return [".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name);
}

export async function prepareUnpreparedExternalWorkspace(sourceRepo: string, workspace: string, workingDirectory = ".", identity?: { taskId: string; workspaceId: string }, hooks: { beforeOwnedPathMutation?: () => void | Promise<void>; onPrivateDependenciesCreated?: (lease: PrivateDependencyLease) => void | Promise<void> } = {}): Promise<WorkspaceLinkPreparation> {
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
  const lease = { path: privateDependenciesPath, token: randomUUID() } satisfies PrivateDependencyLease;
  privateDependencyCapabilities.set(privateDependenciesPath, { workspaceRoot: canonicalExecutionRoot, manifestPath, taskId, token: lease.token });
  const nextOwner: WorkspaceLinkManifest = { schemaVersion: 1, kind: "workspace-link", taskId, workspaceId, path: target, expectedTarget: privateDependenciesPath, createdAt: new Date().toISOString() };
  let quarantine: string | null = null;
  try { await hooks.onPrivateDependenciesCreated?.(lease); }
  catch (error) { await cleanupPrivateDependencyLease(lease); throw error; }
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
    await cleanupPrivateDependencyLease(lease);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw await workspaceConflict(target, expectedTarget, manifestPath, quarantine ?? undefined);
    throw error;
  }
  if (quarantine) await rm(quarantine, { force: true });
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
export async function cleanupPrivateDependencyLease(lease: PrivateDependencyLease | undefined): Promise<void> { if (!lease) return; const capability = privateDependencyCapabilities.get(lease.path); if (capability?.token !== lease.token || !await trustedPrivateDirectory(lease.path)) return; await rm(lease.path, { recursive: true, force: true }); privateDependencyCapabilities.delete(lease.path); }
export async function cleanupPreparedExternalWorkspace(workspace: string, workingDirectory = "."): Promise<void> { const executionRoot = resolve(workspace, workingDirectory), manifestPath = join(executionRoot, ".runforge-workspace-link-owner.json"), manifest = await readManifest(manifestPath); if (!manifest) return; const capability = privateDependencyCapabilities.get(manifest.expectedTarget), target = join(executionRoot, "node_modules"), actualTarget = await readlink(target).catch(() => null), canonicalRoot = await realpath(executionRoot).catch(() => ""); if (capability && capability.workspaceRoot === canonicalRoot && capability.manifestPath === manifestPath && capability.taskId === manifest.taskId && linkTargetMatches(target, actualTarget, manifest.expectedTarget) && await trustedPrivateDirectory(manifest.expectedTarget)) { await rm(manifest.expectedTarget, { recursive: true, force: true }); privateDependencyCapabilities.delete(manifest.expectedTarget); } }

/** Paths created by RunForge dependency preparation, relative to the disposable worktree. */
export async function preparedWorkspaceArtifactPaths(workspace: string, workingDirectory = "."): Promise<string[]> {
  const executionRoot = resolve(workspace, workingDirectory), manifestPath = join(executionRoot, ".runforge-workspace-link-owner.json"), manifest = await readManifest(manifestPath);
  const target = join(executionRoot, "node_modules");
  if (!manifest || manifest.path !== target || !manifest.expectedTarget) return [];
  const actualTarget = await readlink(target).catch(() => null), capability = privateDependencyCapabilities.get(manifest.expectedTarget), canonicalRoot = await realpath(executionRoot).catch(() => "");
  if (!capability || capability.workspaceRoot !== canonicalRoot || capability.manifestPath !== manifestPath || capability.taskId !== manifest.taskId || !linkTargetMatches(target, actualTarget, manifest.expectedTarget)) return [];
  return [relative(workspace, manifestPath), relative(workspace, target)];
}

/** Remove verified RunForge-only dependency link artifacts before source patch finalization. */
export async function removePreparedWorkspaceArtifacts(workspace: string, workingDirectory = "."): Promise<void> {
  const paths = await preparedWorkspaceArtifactPaths(workspace, workingDirectory);
  if (!paths.length) return;
  const executionRoot = resolve(workspace, workingDirectory);
  await cleanupPreparedExternalWorkspace(workspace, workingDirectory);
  await rm(join(executionRoot, "node_modules"), { recursive: true, force: true });
  await rm(join(executionRoot, ".runforge-workspace-link-owner.json"), { force: true });
}

function linkTargetMatches(linkPath: string, actualTarget: string | null, expectedTarget: string): boolean {
  if (!actualTarget) return false;
  if (actualTarget === expectedTarget) return true;
  return resolve(dirname(linkPath), actualTarget) === expectedTarget;
}
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); }

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
