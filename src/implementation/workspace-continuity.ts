import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const preparationClassifications = ["created", "reused", "repaired", "conflict_external", "unsafe", "cleanup_failed"] as const;
export type PreparationClassification = typeof preparationClassifications[number];
export type DependencyStrategy = "verified_read_only_cache" | "candidate_local_offline_install" | "no_dependencies";
export type PreparationManifest = {
  schemaVersion: 1; taskId: string; workspaceId: string; kind: "workspace" | "dependency";
  strategy: string; classification: PreparationClassification; path: string; owned: boolean;
  source: string | null; sourceSha256: string | null; createdAt: string; detail: string;
};

export async function prepareResumeWorkspace(input: {
  taskId: string; repository: string; baseSha: string; workspace: string; workspaceId: string;
}): Promise<PreparationManifest> {
  const repository = await realpath(input.repository);
  const workspace = resolve(input.workspace);
  if (!isInside(dirname(workspace), workspace) || workspace === repository) return manifest(input, "workspace", "base_patch_worktree", "unsafe", workspace, false, null, null, "Workspace target is unsafe.");
  const ownerPath = `${workspace}.runforge-owner.json`;
  const existing = await pathState(workspace);
  if (existing) {
    const owner = await readManifest(ownerPath);
    if (!owner || owner.taskId !== input.taskId || owner.workspaceId !== input.workspaceId) return manifest(input, "workspace", "base_patch_worktree", "conflict_external", workspace, false, null, null, "Existing workspace is not task-owned.");
    const head = await git(workspace, ["rev-parse", "HEAD"]).catch(() => "");
    if (head.trim() === input.baseSha) return manifest(input, "workspace", "base_patch_worktree", "reused", workspace, true, repository, null, "Task-owned base workspace reused.");
    try { await git(repository, ["worktree", "remove", "--force", workspace]); await rm(workspace, { recursive: true, force: true }); }
    catch { return manifest(input, "workspace", "base_patch_worktree", "cleanup_failed", workspace, true, repository, null, "Task-owned stale workspace cleanup failed."); }
  }
  await mkdir(dirname(workspace), { recursive: true });
  await git(repository, ["cat-file", "-e", `${input.baseSha}^{commit}`]);
  await git(repository, ["worktree", "add", "--detach", workspace, input.baseSha]);
  const result = manifest(input, "workspace", "base_patch_worktree", existing ? "repaired" : "created", workspace, true, repository, null, "Disposable workspace prepared from the expected base SHA.");
  await atomicJson(ownerPath, result);
  return result;
}

export async function prepareTaskOwnedDependencies(input: {
  taskId: string; workspaceId: string; workspaceRoot: string; executionRoot: string; strategy: DependencyStrategy;
  cacheRoot?: string; cacheSha256?: string; packageManager?: "npm" | "pnpm" | "yarn" | "bun";
}): Promise<PreparationManifest> {
  const workspace = await realpath(input.workspaceRoot), executionRoot = await realpath(resolve(input.executionRoot)).catch(() => resolve(input.executionRoot));
  if (!isInside(workspace, executionRoot)) return manifest(input, "dependency", input.strategy, "unsafe", executionRoot, false, null, null, "Dependency target escapes the workspace.");
  const target = join(executionRoot, "node_modules"), ownerPath = join(executionRoot, ".runforge-dependency-owner.json");
  const owned = await readManifest(ownerPath);
  if (input.strategy === "no_dependencies") {
    const result = manifest(input, "dependency", input.strategy, owned ? "reused" : "created", target, true, null, null, "No dependency preparation requested.");
    if (!owned) await atomicJson(ownerPath, result); return result;
  }
  if (input.strategy === "candidate_local_offline_install") {
    if (await pathState(target)) return manifest(input, "dependency", input.strategy, owned?.taskId === input.taskId ? "reused" : "conflict_external", target, Boolean(owned), null, null, "Existing dependency object classified before offline install.");
    const manager = input.packageManager ?? "npm", args = manager === "npm" ? ["install", "--offline", "--ignore-scripts"] : ["install", "--offline", "--ignore-scripts"];
    try { await execFileAsync(manager, args, { cwd: executionRoot, env: safeEnv(), maxBuffer: 10_000_000 }); }
    catch (error) { return manifest(input, "dependency", input.strategy, "cleanup_failed", target, true, null, null, `Offline install failed: ${(error as Error).message}`); }
    const result = manifest(input, "dependency", input.strategy, "created", target, true, null, null, "Candidate-local offline dependency install completed."); await atomicJson(ownerPath, result); return result;
  }
  if (!input.cacheRoot || !input.cacheSha256) return manifest(input, "dependency", input.strategy, "unsafe", target, false, null, null, "Verified cache strategy requires cacheRoot and cacheSha256.");
  const cache = await realpath(input.cacheRoot).catch(() => null);
  if (!cache || !/^[a-f0-9]{64}$/.test(input.cacheSha256)) return manifest(input, "dependency", input.strategy, "unsafe", target, false, cache, null, "Cache identity is invalid.");
  const cacheVerification = await treeDigest(cache), cacheDigest = cacheVerification.digest;
  if (!cacheVerification.readOnly || cacheDigest !== input.cacheSha256) return manifest(input, "dependency", input.strategy, "unsafe", target, false, cache, cacheDigest, cacheVerification.readOnly ? "Read-only cache digest mismatch." : "Dependency cache is writable.");
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    const correct = existing.isSymbolicLink() && resolve(dirname(target), await readlinkSafe(target)) === cache;
    if (correct) return manifest(input, "dependency", input.strategy, "reused", target, true, cache, cacheDigest, "Verified cache link reused.");
    if (!owned || owned.taskId !== input.taskId || owned.workspaceId !== input.workspaceId) return manifest(input, "dependency", input.strategy, "conflict_external", target, false, cache, cacheDigest, "External dependency object was preserved.");
    try { await rm(target, { recursive: true, force: true }); }
    catch { return manifest(input, "dependency", input.strategy, "cleanup_failed", target, true, cache, cacheDigest, "Task-owned dependency cleanup failed."); }
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try { await symlink(cache, temporary, "dir"); await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); return manifest(input, "dependency", input.strategy, (error as NodeJS.ErrnoException).code === "EEXIST" ? "conflict_external" : "cleanup_failed", target, false, cache, cacheDigest, String((error as Error).message)); }
  const result = manifest(input, "dependency", input.strategy, existing ? "repaired" : "created", target, true, cache, cacheDigest, existing ? "Task-owned broken dependency link atomically repaired." : "Verified read-only cache linked."); await atomicJson(ownerPath, result); return result;
}

async function treeDigest(root: string): Promise<{ digest: string; readOnly: boolean }> {
  const { readdir } = await import("node:fs/promises"); const hash = createHash("sha256"); let readOnly = ((await lstat(root)).mode & 0o222) === 0;
  const visit = async (path: string): Promise<void> => { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name), rel = relative(root, child), metadata = await lstat(child); readOnly &&= (metadata.mode & 0o222) === 0; hash.update(`${rel}\0${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}\0`); if (entry.isDirectory()) await visit(child); else if (entry.isFile()) hash.update(await readFile(child)); else hash.update(await readlinkSafe(child)); } }; await visit(root); return { digest: hash.digest("hex"), readOnly };
}
function manifest(input: { taskId: string; workspaceId: string }, kind: "workspace" | "dependency", strategy: string, classification: PreparationClassification, path: string, owned: boolean, source: string | null, sourceSha256: string | null, detail: string): PreparationManifest { return { schemaVersion: 1, taskId: input.taskId, workspaceId: input.workspaceId, kind, strategy, classification, path, owned, source, sourceSha256, createdAt: new Date().toISOString(), detail }; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
async function readManifest(path: string): Promise<PreparationManifest | null> { try { return JSON.parse(await readFile(path, "utf8")) as PreparationManifest; } catch { return null; } }
async function pathState(path: string): Promise<boolean> { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error)); }
async function readlinkSafe(path: string): Promise<string> { return import("node:fs/promises").then(({ readlink }) => readlink(path)); }
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd, maxBuffer: 10_000_000 })).stdout; }
function isInside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); }
function safeEnv(): NodeJS.ProcessEnv { return { PATH: process.env.PATH, HOME: "/dev/null", LANG: "C", LC_ALL: "C", npm_config_offline: "true", npm_config_ignore_scripts: "true" }; }
