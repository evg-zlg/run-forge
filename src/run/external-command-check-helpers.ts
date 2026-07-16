import { join } from "node:path";
import { validateCommandSafety } from "./command-safety.js";
import type { CliExitPolicy, CommandResult, ExternalCheckStatus } from "./external-command-check-types.js";

export function blockedCommandReports(commands: string[], phase: "setup" | "main"): Array<{ phase: "setup" | "main"; index: number; command: string; reason: string }> {
  const reports: Array<{ phase: "setup" | "main"; index: number; command: string; reason: string }> = [];
  commands.forEach((command, offset) => {
    const safety = validateCommandSafety(command);
    const policyBlock = blockedExternalCommandReason(command);
    const reason = safety?.reason ?? policyBlock;
    if (reason) reports.push({ phase, index: offset + 1, command, reason });
  });
  return reports;
}

export function blockedResult(blocked: { phase: "setup" | "main"; index: number; command: string; reason: string }, cwd: string, runId: string): CommandResult {
  const now = new Date().toISOString();
  const prefix = blocked.phase === "setup" ? "setup" : "command";
  return {
    commandId: `${runId}:${blocked.phase === "setup" ? "setup" : "command"}:${String(blocked.index).padStart(3, "0")}`,
    phase: blocked.phase,
    index: blocked.index,
    command: blocked.command,
    cwd,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    status: "blocked",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutPath: `logs/${prefix}-${String(blocked.index).padStart(3, "0")}.stdout.log`,
    stderrPath: `logs/${prefix}-${String(blocked.index).padStart(3, "0")}.stderr.log`,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    blockReason: blocked.reason
  };
}

export function finalStatus(
  current: ExternalCheckStatus,
  setupResults: CommandResult[],
  commandResults: CommandResult[],
  mutationVerdict: string,
  continueAfterSetupFailure = false
): ExternalCheckStatus {
  if (mutationVerdict === "changed") return "error";
  if (current === "blocked") return "blocked";
  const setupFailure = setupPhaseStatus(setupResults);
  if (setupResults.length > 0 && setupFailure !== "setup_passed") {
    if (!continueAfterSetupFailure) return setupFailure;
    return mainCommandsPassed(commandResults) ? "setup_failed_main_passed" : "setup_failed_main_failed";
  }
  if (commandResults.some((result) => result.status === "timed_out")) return "timed_out";
  if (commandResults.some((result) => result.status === "error")) return "error";
  if (commandResults.some((result) => result.status === "failed")) return "failed";
  return "passed";
}

export function setupPhaseStatus(setupResults: CommandResult[]): "setup_passed" | "setup_failed" | "setup_timed_out" | "setup_error" {
  if (setupResults.some((result) => result.status === "timed_out")) return "setup_timed_out";
  if (setupResults.some((result) => result.status === "error")) return "setup_error";
  if (setupResults.some((result) => result.status === "failed" || result.status === "blocked")) return "setup_failed";
  return "setup_passed";
}

export function firstSetupFailure(setupResults: CommandResult[]): CommandResult | undefined {
  return setupResults.find((result) => result.status !== "passed");
}

export function cliExitCodeFor(policy: CliExitPolicy, status: ExternalCheckStatus): number {
  if (policy === "packet") return 0;
  return status === "passed" ? 0 : 1;
}

export function defaultExternalCheckOutDir(): string {
  return join(process.cwd(), "artifacts", "external-check");
}

function blockedExternalCommandReason(command: string): string | undefined {
  if (/\bgit\s+push\b/.test(command)) return "Blocked external check command: git push is not allowed.";
  if (/\bgit\s+merge\b/.test(command)) return "Blocked external check command: git merge is not allowed.";
  if (/\bdeploy\b/.test(command)) return "Blocked external check command: deploy commands are not allowed.";
  if (/\bprintenv\b|\$(?:\{|)[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/i.test(command)) return "Blocked external check command: environment credentials must not be read.";
  return undefined;
}

function mainCommandsPassed(commandResults: CommandResult[]): boolean {
  return commandResults.length > 0 && commandResults.every((result) => result.status === "passed");
}
