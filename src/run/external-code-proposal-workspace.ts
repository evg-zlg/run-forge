import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runOneCommand } from "./external-command-check-exec.js";
import type { CommandResult } from "./external-command-check-types.js";

const execFileAsync = promisify(execFile);

export interface ReadinessContractForVerification {
  suggestedVerificationCommands?: string[];
}

export interface CheckRunForVerification {
  commands?: CommandResult[];
}

export function verificationCommandsFor(
  contract: ReadinessContractForVerification,
  sourceCheckRun: CheckRunForVerification | null,
  explicitCommands?: string[]
): string[] {
  if (explicitCommands && explicitCommands.length > 0) return explicitCommands;
  const failed = sourceCheckRun?.commands?.filter((result) => result.status !== "passed").map((result) => result.command) ?? [];
  if (failed.length > 0) return failed;
  const suggested = contract.suggestedVerificationCommands?.filter((command) => command !== "original failing command") ?? [];
  return suggested.length > 0 ? suggested : ["node --version"];
}

export async function applyPatchInWorkspace(workspacePath: string, patch: string): Promise<string> {
  const patchPath = join(workspacePath, ".runforge-proposal.patch");
  await writeFile(patchPath, patch, "utf8");
  try {
    await execFileAsync("git", ["apply", patchPath], { cwd: workspacePath, maxBuffer: 1024 * 1024 });
    return "applied";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runVerificationCommands(input: {
  runId: string;
  workspacePath: string;
  logsDir: string;
  commands: string[];
  timeoutMs?: number;
  maxLogBytes?: number;
  markArtifact: (path: string, artifactType?: string) => Promise<void>;
  emit: (type: string, data?: object) => string;
}): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  const timeoutMs = input.timeoutMs ?? 120_000;
  const maxLogBytes = input.maxLogBytes ?? 1_000_000;
  for (let i = 0; i < input.commands.length; i += 1) {
    const index = i + 1;
    const command = input.commands[i]!;
    const commandId = `${input.runId}:verify:${String(index).padStart(3, "0")}`;
    input.emit("verification_command_started", { commandId, index, command });
    const result = await runOneCommand({ commandId, index, command, cwd: input.workspacePath, timeoutMs, maxLogBytes, logsDir: input.logsDir });
    results.push(result);
    await input.markArtifact(result.stdoutPath, "log");
    await input.markArtifact(result.stderrPath, "log");
    input.emit("verification_command_finished", { commandId, index, command, status: result.status, exitCode: result.exitCode });
  }
  return results;
}
