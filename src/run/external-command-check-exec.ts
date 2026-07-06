import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CommandPhase, CommandResult, CommandStatus } from "./external-command-check-types.js";

export async function runOneCommand(input: {
  commandId: string;
  phase?: CommandPhase;
  index: number;
  command: string;
  cwd: string;
  timeoutMs: number;
  maxLogBytes: number;
  logsDir: string;
}): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const phase = input.phase ?? "main";
  const logPrefix = phase === "setup" ? "setup" : "command";
  const stdoutPath = `logs/${logPrefix}-${String(input.index).padStart(3, "0")}.stdout.log`;
  const stderrPath = `logs/${logPrefix}-${String(input.index).padStart(3, "0")}.stderr.log`;
  const stdoutFullPath = join(input.logsDir, basename(stdoutPath));
  const stderrFullPath = join(input.logsDir, basename(stderrPath));
  await mkdir(input.logsDir, { recursive: true });
  const stdout = createLimitedLogWriter(stdoutFullPath, input.maxLogBytes);
  const stderr = createLimitedLogWriter(stderrFullPath, input.maxLogBytes);

  return new Promise((resolveResult) => {
    let timedOut = false;
    let settled = false;
    let spawnError: Error | undefined;
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1_000).unref();
    }, input.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      void Promise.all([stdout.end(), stderr.end()]).then(() => {
        const finishedAt = new Date().toISOString();
        const status: CommandStatus = spawnError ? "error" : timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed";
        resolveResult({
          commandId: input.commandId,
          phase,
          index: input.index,
          command: input.command,
          cwd: input.cwd,
          startedAt,
          finishedAt,
          durationMs: Date.now() - startMs,
          status,
          exitCode,
          signal,
          timedOut,
          stdoutPath,
          stderrPath,
          stdoutBytes: stdout.bytesWritten,
          stderrBytes: stderr.bytesWritten,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated
        });
      });
    });
  });
}

function createLimitedLogWriter(path: string, maxBytes: number) {
  const stream = createWriteStream(path, { encoding: "utf8" });
  let bytesWritten = 0;
  let truncated = false;
  return {
    get bytesWritten() {
      return bytesWritten;
    },
    get truncated() {
      return truncated;
    },
    write(chunk: Buffer) {
      if (bytesWritten >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - bytesWritten;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stream.write(slice);
      bytesWritten += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) truncated = true;
    },
    end(): Promise<void> {
      return new Promise((resolveEnd) => {
        stream.end(resolveEnd);
      });
    }
  };
}
