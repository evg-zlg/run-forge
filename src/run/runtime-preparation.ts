import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

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
  target: { platform: "linux"; architecture: string };
  dependencyCommand: string;
  hostNodeModulesReused: false;
  linuxCompatibleDependenciesCreated: true;
  networkUsed: true;
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
  workspace: string;
  outDir: string;
  image: string;
}): Promise<RuntimePreparationResult> {
  const startedAt = new Date().toISOString();
  const source = await inspectRepoState(input.repo);
  const dependency = await detectDependencyContract(source.path);
  const image = await inspectImage(input.image);

  await rm(input.workspace, { recursive: true, force: true });
  await mkdir(input.workspace, { recursive: true });
  await copyExternalWorkspace(source.path, input.workspace);

  const containerName = `runforge-prepare-${safeName(basename(input.outDir))}-${process.pid}`;
  const args = preparationDockerArgs(input.workspace, input.image, containerName, dependency.command);
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
    lockfilePath: dependency.lockfile,
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

export function preparationDockerArgs(workspace: string, image: string, containerName: string, command: string): string[] {
  return [
    "run", "--rm", "--pull", "never", "--name", containerName,
    "--network", "bridge",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--pids-limit", "512",
    "--memory", "2g",
    "--cpus", "2",
    "--user", "0",
    "--mount", `type=bind,src=${workspace},dst=/workspace`,
    "--workdir", "/workspace",
    "--entrypoint", "/bin/sh",
    image,
    "-lc",
    `${command} && mkdir -p /workspace/.runforge-tmp && chmod -R a+rwX /workspace`
  ];
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
      const first = path.split("/")[0];
      if ([".git", "node_modules", "dist", "coverage", ".runforge", "artifacts"].includes(first!)) return false;
      if (first === ".env" || (first?.startsWith(".env.") && first !== ".env.example")) return false;
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
