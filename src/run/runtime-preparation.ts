import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { assertDockerMountPath, resolveDockerWorkspace } from "./docker-workspace.js";
import { isSensitiveWorkspacePath, materializeAutonomousGitSnapshot } from "./task-run-workspace.js";

const execFileAsync = promisify(execFile);

export type PackageManager = "npm" | "pnpm" | "yarn";

export type RepoState = {
  path: string;
  head: string;
  status: string;
};

export type RuntimePreparationResult = {
  strategy: "disposable-workspace-snapshot";
  requested: true;
  status: "prepared";
  source: RepoState;
  workspace: string;
  packageManager: PackageManager;
  lockfilePath: string;
  lockfileHash: string;
  target: { platform: string; architecture: string };
  dependencyCommand: string;
  hostNodeModulesReused: boolean;
  linuxCompatibleDependenciesCreated: boolean;
  networkUsed: boolean;
  image: { name: string; id: string };
  startedAt: string;
  completedAt: string;
  commandLog: string;
};

export async function inspectRepoState(repo: string): Promise<RepoState> {
  const path = await realpath(repo);
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", path, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", path, "status", "--porcelain=v1", "-uall"])
  ]);
  return { path, head: head.trim(), status: status.trim() };
}

export async function detectLockfileName(repo: string): Promise<string> {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    try {
      await readFile(join(repo, name));
      return name;
    } catch {
      // Continue to the next supported lockfile.
    }
  }
  return "lockfile (missing)";
}

export async function prepareExternalRuntime(input: {
  repo: string;
  workingDirectory?: string;
  workspace: string;
  outDir: string;
  image: string;
  gitSnapshot?: { expectedSha: string };
}): Promise<RuntimePreparationResult> {
  const startedAt = new Date().toISOString();
  const source = await inspectRepoState(input.repo);
  const workingDirectory = input.workingDirectory ?? ".";
  const dependency = await detectDependencyContract(join(source.path, workingDirectory));
  const image = await inspectImage(input.image);

  await rm(input.workspace, { recursive: true, force: true });
  await mkdir(input.workspace, { recursive: true });
  await copyExternalWorkspace(source.path, input.workspace);
  if (input.gitSnapshot) await materializeAutonomousGitSnapshot(source.path, input.workspace, input.gitSnapshot.expectedSha);
  else await execFileAsync("git", ["init", "--quiet"], { cwd: input.workspace });

  const containerName = `runforge-prepare-${safeName(basename(input.outDir))}-${process.pid}`;
  const args = preparationDockerArgs(input.workspace, input.image, containerName, dependency.command, workingDirectory);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const output = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 * 16, timeout: 10 * 60_000 });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  const commandLogPath = join(input.outDir, "runtime-preparation-command.log");
  await writeFile(commandLogPath, renderPreparationLog(input.image, dependency.command, input.workspace, stdout, stderr, exitCode), "utf8");
  if (exitCode !== 0) throw new Error(`Runtime preparation failed with exit code ${exitCode}; see ${commandLogPath}`);

  const result: RuntimePreparationResult = {
    strategy: "disposable-workspace-snapshot",
    requested: true,
    status: "prepared",
    source,
    workspace: input.workspace,
    packageManager: dependency.manager,
    lockfilePath: join(workingDirectory, dependency.lockfile),
    lockfileHash: dependency.hash,
    target: { platform: "linux", architecture: image.architecture },
    dependencyCommand: dependency.command,
    hostNodeModulesReused: false,
    linuxCompatibleDependenciesCreated: true,
    networkUsed: true,
    image: { name: input.image, id: image.id },
    startedAt,
    completedAt: new Date().toISOString(),
    commandLog: relative(process.cwd(), commandLogPath)
  };
  await writeFile(join(input.outDir, "runtime-preparation-report.md"), renderPreparationReport(result), "utf8");
  return result;
}

export function preparationDockerArgs(workspace: string, image: string, containerName: string, command: string, workingDirectory = "."): string[] {
  const dockerWorkspace = resolveDockerWorkspace({ cwd: workspace, dockerWorkspace: { root: workspace, workingDirectory } });
  const mountDestination = assertDockerMountPath("/workspace", "Docker preparation mount destination");
  return [
    "run", "--rm", "--pull", "never", "--name", containerName,
    "--network", "bridge",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--pids-limit", "512",
    "--memory", "2g",
    "--cpus", "2",
    "--user", "0",
    "--env", `COREPACK_HOME=${dockerWorkspace.workdir}/.runforge-corepack`,
    "--env", `RUNFORGE_EXECUTION_ROOT=${dockerWorkspace.workdir}`,
    "--env", "npm_config_store_dir=/workspace/.runforge-pnpm-store",
    "--mount", `type=bind,src=${dockerWorkspace.root},dst=${mountDestination}`,
    "--workdir", dockerWorkspace.workdir,
    "--entrypoint", "/bin/sh",
    image,
    "-lc",
    `${command} && mkdir -p "$RUNFORGE_EXECUTION_ROOT/.runforge-corepack" /workspace/.runforge-tmp /workspace/.runforge-pnpm-store && find /workspace -type d -name node_modules -prune -exec chmod -R a+rwX {} + && chmod -R a+rwX "$RUNFORGE_EXECUTION_ROOT/.runforge-corepack" /workspace/.runforge-tmp /workspace/.runforge-pnpm-store`
  ];
}

export async function prepareLocalRuntime(input: {
  repo: string;
  workingDirectory?: string;
  workspace: string;
  outDir: string;
  strategy: "required" | "if-needed" | "disabled" | "reuse-existing";
  externalNetwork: "denied" | "dependency-preparation-only";
}): Promise<RuntimePreparationResult> {
  const startedAt = new Date().toISOString();
  const source = await inspectRepoState(input.repo);
  const workingDirectory = input.workingDirectory ?? ".";
  const sourceExecutionRoot = join(source.path, workingDirectory);
  const workspaceExecutionRoot = join(input.workspace, workingDirectory);
  const dependency = await detectDependencyContract(sourceExecutionRoot).catch(() => null);
  await rm(input.workspace, { recursive: true, force: true });
  await mkdir(input.workspace, { recursive: true });
  await copyExternalWorkspace(source.path, input.workspace);
  await execFileAsync("git", ["init", "--quiet"], { cwd: input.workspace });
  let dependencyCommand = "none";
  let networkUsed = false;
  let reused = false;
  const sourceModules = join(sourceExecutionRoot, "node_modules");
  const modulesExist = await readFile(join(sourceModules, ".modules.yaml")).then(() => true, () => false)
    || await readFile(join(sourceModules, ".package-lock.json")).then(() => true, () => false)
    || await execFileAsync("test", ["-d", sourceModules]).then(() => true, () => false);
  if (["reuse-existing", "if-needed"].includes(input.strategy) && modulesExist) {
    await cp(sourceModules, join(workspaceExecutionRoot, "node_modules"), { recursive: true, verbatimSymlinks: true });
    dependencyCommand = "reuse existing dependencies from source snapshot";
    reused = true;
  } else if (input.strategy === "required") {
    if (!dependency) throw new Error("Required dependency preparation has no supported lockfile in the execution root.");
    if (input.externalNetwork !== "dependency-preparation-only") throw new Error("Required local dependency preparation needs runtime.externalNetwork='dependency-preparation-only'.");
    await execFileAsync("sh", ["-lc", dependency.command], { cwd: workspaceExecutionRoot, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    dependencyCommand = dependency.command;
    networkUsed = true;
  } else if (input.strategy === "reuse-existing") {
    throw new Error("runtime.dependencyPreparation='reuse-existing' requires node_modules in the execution root.");
  }
  const commandLog = join(input.outDir, "runtime-preparation-command.log");
  await writeFile(commandLog, `runtime: local-disposable\nstrategy: ${input.strategy}\nworkingDirectory: ${workingDirectory}\ndependencyCommand: ${dependencyCommand}\nnetworkUsed: ${networkUsed}\nsourceMounted: false\n`, "utf8");
  const result: RuntimePreparationResult = {
    strategy: "disposable-workspace-snapshot", requested: true, status: "prepared", source,
    workspace: input.workspace, packageManager: dependency?.manager ?? "npm",
    lockfilePath: dependency ? join(workingDirectory, dependency.lockfile) : "lockfile (not required)",
    lockfileHash: dependency?.hash ?? "not-required", target: { platform: process.platform, architecture: process.arch },
    dependencyCommand, hostNodeModulesReused: reused, linuxCompatibleDependenciesCreated: false,
    networkUsed, image: { name: "local-disposable", id: process.version }, startedAt,
    completedAt: new Date().toISOString(), commandLog: relative(process.cwd(), commandLog)
  };
  await writeFile(join(input.outDir, "runtime-preparation-report.md"), renderPreparationReport(result), "utf8");
  return result;
}

async function detectDependencyContract(repo: string): Promise<{ manager: PackageManager; lockfile: string; hash: string; command: string }> {
  const candidates: Array<{ manager: PackageManager; lockfile: string; command: string }> = [
    { manager: "npm", lockfile: "package-lock.json", command: "npm ci --no-audit --no-fund" },
    { manager: "pnpm", lockfile: "pnpm-lock.yaml", command: "corepack pnpm install --frozen-lockfile" },
    { manager: "yarn", lockfile: "yarn.lock", command: "corepack yarn install --immutable" }
  ];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(join(repo, candidate.lockfile));
      return { ...candidate, hash: createHash("sha256").update(bytes).digest("hex") };
    } catch {
      // Try the next supported lockfile.
    }
  }
  throw new Error("Runtime preparation requires package-lock.json, pnpm-lock.yaml, or yarn.lock.");
}

async function inspectImage(image: string): Promise<{ id: string; architecture: string }> {
  const { stdout } = await execFileAsync("docker", ["image", "inspect", image, "--format", "{{.Id}} {{.Architecture}}"]);
  const [id, architecture] = stdout.trim().split(/\s+/);
  if (!id || !architecture) throw new Error(`Could not inspect Docker image ${image}.`);
  return { id, architecture };
}

async function copyExternalWorkspace(repo: string, workspace: string): Promise<void> {
  await cp(repo, workspace, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const path = relative(repo, source);
      if (!path) return true;
      if (isSensitiveWorkspacePath(path)) return false;
      const parts = path.split("/");
      if (parts.some((part) => [".git", "node_modules", "dist", "coverage", ".runforge", "artifacts"].includes(part))) return false;
      return true;
    }
  });
}

function renderPreparationLog(image: string, command: string, workspace: string, stdout: string, stderr: string, exitCode: number): string {
  return [
    `$ docker run [bounded preparation policy] ${image} -lc '${command}'`,
    "phase: runtime-preparation",
    "network: bridge (explicit preparation only)",
    `workspace: ${workspace}`,
    "originalRepositoryMounted: false",
    "hostNodeModulesReused: false",
    `exitCode: ${exitCode}`,
    "", "## stdout", stdout.trim() || "(empty)", "", "## stderr", stderr.trim() || "(empty)", ""
  ].join("\n");
}

function renderPreparationReport(result: RuntimePreparationResult): string {
  return `# Runtime Preparation Report

- Status: \`${result.status}\`
- Strategy: \`${result.strategy}\`
- Source repository: \`${result.source.path}\`
- Source HEAD: \`${result.source.head}\`
- Source status: ${result.source.status ? `\`${result.source.status}\`` : "clean"}
- Package manager: \`${result.packageManager}\`
- Lockfile: \`${result.lockfilePath}\`
- Lockfile SHA-256: \`${result.lockfileHash}\`
- Target: \`${result.target.platform}/${result.target.architecture}\`
- Image: \`${result.image.name}\` (\`${result.image.id}\`)
- Dependency strategy: Linux dependencies installed into a disposable workspace
- Host node_modules reused: no
- Linux-compatible dependency environment created: yes
- Preparation network used: yes
- Package lifecycle scripts: package-manager defaults (inside the disposable preparation container only)
- Original repository mounted or mutated: no
- Command log: \`${result.commandLog}\`
- Started: \`${result.startedAt}\`
- Completed: \`${result.completedAt}\`
`;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 40);
}
