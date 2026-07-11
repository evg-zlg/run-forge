import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutorResult } from "./task-run-executor.js";
import type { CheckResult, EvidenceRecord, Subtask } from "./task-run-harness.js";
import type { PlannedSubtask } from "./task-run-planner.js";

const execFileAsync = promisify(execFile);

export async function runOwnerCheck(command: string, cwd: string): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], { cwd, maxBuffer: 1024 * 1024 * 8 });
    return { command, result: "passed", exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { command, result: "failed", exitCode: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

export function completeExecutedSubtask(planned: PlannedSubtask, result: ExecutorResult): Subtask {
  const evidence: EvidenceRecord = {
    command: planned.evidenceCommand,
    status: result.status,
    exitCode: result.exitCode,
    logPath: result.artifactPaths.commandLog,
    inspected: planned.inputs,
    summary: summarizeEvidence(planned, result),
    executorReport: result.artifactPaths.report
  };
  return {
    id: planned.id,
    goal: planned.goal,
    inputs: planned.inputs,
    findings: [`${planned.evidenceFocus} Evidence command ${evidence.status} with exit code ${evidence.exitCode}.`, evidence.summary],
    status: "done",
    artifacts: ["brief.md", "report.md", "command.log", "stdout.log", "stderr.log", "executor-report.json"],
    evidence,
    executor: result
  };
}

export function parseProviderArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeEvidence(subtask: PlannedSubtask, result: ExecutorResult): string {
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sample = lines.slice(0, 3).join(" | ");
  if (lines.length === 0) return `${subtask.id} produced no stdout; inspect ${subtask.inputs.join(", ")} manually.`;
  return `${subtask.id} inspected ${subtask.inputs.length} input(s) and captured ${lines.length} stdout line(s). Sample: ${sample}`;
}
