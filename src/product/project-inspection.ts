import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckStatus = "passed" | "warning" | "blocked" | "not_required";
export type ReadinessCheck = { id: string; status: CheckStatus; required: boolean; summary: string; details?: Record<string, unknown> };
export type ProjectInspection = {
  requestedPath: string;
  requestedWorkingDirectory: string;
  path: string | null;
  repositoryRoot: string | null;
  executionRoot: string | null;
  workingDirectory: string | null;
  exists: boolean;
  isGitRepository: boolean;
  head: string | null;
  branch: string | null;
  detachedHead: boolean;
  worktree: { clean: boolean | null; summary: string | null };
  defaultBranch: string | null;
  packageManager: string | null;
  dependencyPreparation: { supported: boolean; lockfile: string | null; command: string | null };
  validationCommands: string[];
};

export async function inspectProject(input: string, workingDirectory = "."): Promise<ProjectInspection> {
  const requestedPath = resolve(input);
  assertWorkingDirectorySyntax(workingDirectory);
  const info = await stat(requestedPath).catch(() => null);
  if (!info?.isDirectory()) return emptyInspection(requestedPath, workingDirectory);
  const path = await realpath(requestedPath);
  const gitRoot = await git(path, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) return { ...emptyInspection(requestedPath, workingDirectory), path, exists: true };
  const canonicalRoot = await realpath(gitRoot);
  const requestedExecutionRoot = resolve(canonicalRoot, workingDirectory);
  const executionInfo = await stat(requestedExecutionRoot).catch(() => null);
  if (!executionInfo?.isDirectory()) throw new Error(`target.workingDirectory must resolve to an existing directory: ${requestedExecutionRoot}`);
  const executionRoot = await realpath(requestedExecutionRoot);
  if (!(await isPathInside(canonicalRoot, executionRoot))) throw new Error(`target.workingDirectory escapes target.repository: ${workingDirectory}`);
  const normalizedWorkingDirectory = relative(canonicalRoot, executionRoot) || ".";
  const [head, branchOutput, status, defaultBranch] = await Promise.all([
    git(canonicalRoot, ["rev-parse", "HEAD"]),
    git(canonicalRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(canonicalRoot, ["status", "--porcelain=v1", "-uall"]),
    discoverDefaultBranch(canonicalRoot)
  ]);
  const packageInfo = await discoverPackageContract(executionRoot);
  return {
    requestedPath,
    requestedWorkingDirectory: workingDirectory,
    path: canonicalRoot,
    repositoryRoot: canonicalRoot,
    executionRoot,
    workingDirectory: normalizedWorkingDirectory,
    exists: true,
    isGitRepository: true,
    head,
    branch: branchOutput,
    detachedHead: branchOutput === null,
    worktree: { clean: status === "", summary: status || null },
    defaultBranch,
    packageManager: packageInfo.manager,
    dependencyPreparation: packageInfo.preparation,
    validationCommands: packageInfo.commands
  };
}

export async function isPathInside(parent: string, child: string): Promise<boolean> {
  const [canonicalParent, canonicalChild] = await Promise.all([canonicalPotentialPath(parent), canonicalPotentialPath(child)]);
  const fromParent = relative(canonicalParent, canonicalChild);
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function defaultArtifactRoot(repo: string): string {
  const root = resolve(repo);
  return join(dirname(root), ".runforge-artifacts", basename(root));
}

export async function commandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10_000 });
    return (stdout || stderr).trim() || "available";
  } catch {
    return null;
  }
}

async function discoverPackageContract(executionRoot: string): Promise<{ manager: string | null; commands: string[]; preparation: ProjectInspection["dependencyPreparation"] }> {
  const candidates = [
    { file: "pnpm-lock.yaml", manager: "pnpm", prefix: "corepack pnpm", preparation: "corepack pnpm install --frozen-lockfile" },
    { file: "package-lock.json", manager: "npm", prefix: "npm", preparation: "npm ci --no-audit --no-fund" },
    { file: "yarn.lock", manager: "yarn", prefix: "corepack yarn", preparation: "corepack yarn install --immutable" },
    { file: "bun.lockb", manager: "bun", prefix: "bun", preparation: null }
  ];
  const candidate = await firstExisting(executionRoot, candidates);
  const packageJson = await readJson(join(executionRoot, "package.json"));
  const scripts = record(packageJson?.scripts);
  const manager = candidate?.manager ?? (packageJson ? "npm" : null);
  const prefix = candidate?.prefix ?? "npm";
  const safeNames = ["typecheck", "test", "build", "lint", "check"];
  const commands = safeNames.filter((name) => typeof scripts?.[name] === "string").map((name) => `${prefix} ${name === "test" ? "test" : `run ${name}`}`);
  return { manager, commands, preparation: { supported: candidate?.preparation != null, lockfile: candidate ? join(executionRoot, candidate.file) : null, command: candidate?.preparation ?? null } };
}

async function discoverDefaultBranch(repo: string): Promise<string | null> {
  const originHead = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const name of ["main", "master"]) if (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null) return name;
  return null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 10_000 });
    return stdout.trim();
  } catch (error) {
    const code = (error as { code?: number }).code;
    return code === 0 ? "" : null;
  }
}

async function firstExisting<T extends { file: string }>(repo: string, values: T[]): Promise<T | null> {
  for (const value of values) if (await access(join(repo, value.file)).then(() => true, () => false)) return value;
  return null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function emptyInspection(path: string, workingDirectory: string): ProjectInspection {
  return { requestedPath: path, requestedWorkingDirectory: workingDirectory, path: null, repositoryRoot: null, executionRoot: null, workingDirectory: null, exists: false, isGitRepository: false, head: null, branch: null, detachedHead: false, worktree: { clean: null, summary: null }, defaultBranch: null, packageManager: null, dependencyPreparation: { supported: false, lockfile: null, command: null }, validationCommands: [] };
}

function assertWorkingDirectorySyntax(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("target.workingDirectory must be a non-empty relative path.");
  if (isAbsolute(value)) throw new Error("target.workingDirectory must be relative to target.repository.");
  const parts = value.split(/[\\/]+/);
  if (parts.includes("..")) throw new Error("target.workingDirectory must not contain path traversal ('..').");
  if (value.includes(`..${sep}`)) throw new Error("target.workingDirectory must not contain path traversal ('..').");
}

async function canonicalPotentialPath(input: string): Promise<string> {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return missing.reduceRight((path, segment) => join(path, segment), existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return cursor;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}
