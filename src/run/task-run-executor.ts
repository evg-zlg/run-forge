import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecutorRequest = {
  id: string;
  subtaskId: string;
  command: string;
  cwd: string;
  artifactDir: string;
  timeoutMs: number;
};

export type ExecutorLane = "local-shell" | "docker-shell";

export type ExecutorResult = {
  requestId: string;
  subtaskId: string;
  executor: ExecutorLane;
  runtime: {
    isolation: "host-process" | "docker-container";
    image: string | null;
    network: "host" | "none";
  };
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  artifactPaths: {
    commandLog: string;
    stdoutLog: string;
    stderrLog: string;
    report: string;
  };
};

export type TaskRunExecutor = {
  lane: ExecutorLane;
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
};

export class LocalShellExecutor implements TaskRunExecutor {
  readonly lane = "local-shell" as const;

  constructor(private readonly repoRoot: string, private readonly controlledEnvironment = false) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    await mkdir(request.artifactDir, { recursive: true });

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let timedOut = false;

    try {
      const output = await execFileAsync("sh", ["-lc", request.command], {
        cwd: request.cwd,
        env: this.controlledEnvironment ? controlledLocalEnvironment() : process.env,
        maxBuffer: 1024 * 1024 * 8,
        timeout: request.timeoutMs
      });
      stdout = output.stdout;
      stderr = output.stderr;
    } catch (error) {
      const err = error as { code?: number | string; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      exitCode = typeof err.code === "number" ? err.code : null;
      signal = err.signal ?? null;
      timedOut = err.killed === true && signal === "SIGTERM";
    }

    const status = timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed";
    const paths = {
      commandLog: join(request.artifactDir, "command.log"),
      stdoutLog: join(request.artifactDir, "stdout.log"),
      stderrLog: join(request.artifactDir, "stderr.log"),
      report: join(request.artifactDir, "executor-report.json")
    };
    const result: ExecutorResult = {
      requestId: request.id,
      subtaskId: request.subtaskId,
      executor: this.lane,
      runtime: {
        isolation: "host-process",
        image: null,
        network: "host"
      },
      status,
      exitCode,
      signal,
      timedOut,
      stdout,
      stderr,
      artifactPaths: {
        commandLog: relative(this.repoRoot, paths.commandLog),
        stdoutLog: relative(this.repoRoot, paths.stdoutLog),
        stderrLog: relative(this.repoRoot, paths.stderrLog),
        report: relative(this.repoRoot, paths.report)
      }
    };

    await writeFile(paths.stdoutLog, stdout, "utf8");
    await writeFile(paths.stderrLog, stderr, "utf8");
    await writeFile(paths.commandLog, renderCommandLog(request, result), "utf8");
    await writeFile(paths.report, JSON.stringify(toExecutorReport(request, result, this.repoRoot), null, 2) + "\n", "utf8");
    return result;
  }
}

function controlledLocalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM"];
  return { ...Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])), CI: "1", RUNFORGE_RUNTIME_NETWORK: "denied" };
}

export class DockerShellExecutor implements TaskRunExecutor {
  readonly lane = "docker-shell" as const;

  constructor(
    private readonly repoRoot: string,
    private readonly image: string,
    private readonly writableWorkspace = false,
    private readonly readonlySource?: string
  ) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    await mkdir(request.artifactDir, { recursive: true });

    const containerName = dockerContainerName(request.id);
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let timedOut = false;

    try {
      const output = await execFileAsync("docker", dockerRunArgs(request, this.image, containerName, this.writableWorkspace, this.readonlySource), {
        maxBuffer: 1024 * 1024 * 8,
        timeout: request.timeoutMs
      });
      stdout = output.stdout;
      stderr = output.stderr;
    } catch (error) {
      const err = error as { code?: number | string; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      exitCode = typeof err.code === "number" ? err.code : null;
      signal = err.signal ?? null;
      timedOut = err.killed === true && signal === "SIGTERM";
      if (timedOut) await removeContainer(containerName);
    }

    const status = timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed";
    const paths = {
      commandLog: join(request.artifactDir, "command.log"),
      stdoutLog: join(request.artifactDir, "stdout.log"),
      stderrLog: join(request.artifactDir, "stderr.log"),
      report: join(request.artifactDir, "executor-report.json")
    };
    const result: ExecutorResult = {
      requestId: request.id,
      subtaskId: request.subtaskId,
      executor: this.lane,
      runtime: {
        isolation: "docker-container",
        image: this.image,
        network: "none"
      },
      status,
      exitCode,
      signal,
      timedOut,
      stdout,
      stderr,
      artifactPaths: {
        commandLog: relative(this.repoRoot, paths.commandLog),
        stdoutLog: relative(this.repoRoot, paths.stdoutLog),
        stderrLog: relative(this.repoRoot, paths.stderrLog),
        report: relative(this.repoRoot, paths.report)
      }
    };

    await writeFile(paths.stdoutLog, stdout, "utf8");
    await writeFile(paths.stderrLog, stderr, "utf8");
    await writeFile(paths.commandLog, renderCommandLog(request, result), "utf8");
    await writeFile(paths.report, JSON.stringify(toExecutorReport(request, result, this.repoRoot), null, 2) + "\n", "utf8");
    return result;
  }
}

export function dockerRunArgs(request: ExecutorRequest, image: string, containerName: string, writableWorkspace = false, readonlySource?: string): string[] {
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    containerName,
    "--network",
    "none",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "512",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--env",
    "HOME=/tmp",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "TMPDIR=/runforge-tmp",
    "--mount",
    `type=bind,src=${request.cwd},dst=/workspace${writableWorkspace ? "" : ",readonly"}`,
    ...(writableWorkspace ? ["--mount", `type=bind,src=${request.cwd}/.runforge-tmp,dst=/runforge-tmp`] : []),
    ...(readonlySource ? ["--mount", `type=bind,src=${readonlySource},dst=/source/node_modules,readonly`] : []),
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/bin/sh",
    image,
    "-lc",
    request.command
  ];
}

async function removeContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 10_000 });
  } catch {
    // Best effort cleanup after the docker client itself timed out.
  }
}

function dockerContainerName(requestId: string): string {
  const safe = requestId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `runforge-${safe}-${process.pid}`;
}

function renderCommandLog(request: ExecutorRequest, result: ExecutorResult): string {
  return [
    `$ ${request.command}`,
    `executor: ${result.executor}`,
    `isolation: ${result.runtime.isolation}`,
    `image: ${result.runtime.image ?? "none"}`,
    `network: ${result.runtime.network}`,
    `requestId: ${result.requestId}`,
    `cwd: ${request.cwd}`,
    `timeoutMs: ${request.timeoutMs}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode ?? "null"}`,
    `signal: ${result.signal ?? "null"}`,
    "",
    "## stdout",
    result.stdout.trim() || "(empty)",
    "",
    "## stderr",
    result.stderr.trim() || "(empty)",
    ""
  ].join("\n");
}

function toExecutorReport(request: ExecutorRequest, result: ExecutorResult, repoRoot: string): unknown {
  return {
    request: {
      id: request.id,
      subtaskId: request.subtaskId,
      command: request.command,
      cwd: request.cwd,
      artifactDir: relative(repoRoot, request.artifactDir),
      timeoutMs: request.timeoutMs
    },
    result: {
      executor: result.executor,
      runtime: result.runtime,
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutLog: result.artifactPaths.stdoutLog,
      stderrLog: result.artifactPaths.stderrLog,
      commandLog: result.artifactPaths.commandLog
    }
  };
}

export function createExecutorRequest(input: {
  runId: string;
  subtaskId: string;
  command: string;
  cwd: string;
  artifactDir: string;
  timeoutMs?: number;
  lane?: ExecutorLane;
}): ExecutorRequest {
  return {
    id: `${basename(input.runId)}:${input.subtaskId}:${input.lane ?? "local-shell"}`,
    subtaskId: input.subtaskId,
    command: input.command,
    cwd: input.cwd,
    artifactDir: input.artifactDir,
    timeoutMs: input.timeoutMs ?? 30_000
  };
}
