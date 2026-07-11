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

export type ExecutorResult = {
  requestId: string;
  subtaskId: string;
  executor: "local-shell";
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
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
};

export class LocalShellExecutor implements TaskRunExecutor {
  constructor(private readonly repoRoot: string) {}

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
      executor: "local-shell",
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

function renderCommandLog(request: ExecutorRequest, result: ExecutorResult): string {
  return [
    `$ ${request.command}`,
    `executor: ${result.executor}`,
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
}): ExecutorRequest {
  return {
    id: `${basename(input.runId)}:${input.subtaskId}:local-shell`,
    subtaskId: input.subtaskId,
    command: input.command,
    cwd: input.cwd,
    artifactDir: input.artifactDir,
    timeoutMs: input.timeoutMs ?? 30_000
  };
}
