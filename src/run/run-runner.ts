import { join, resolve } from "node:path";
import { ensureDir, readText, writeJson, writeText } from "../core/artifact-store.js";
import { buildSafetyReport } from "../core/safety.js";
import type { RunRecord, RunSpec } from "../core/types.js";
import { createRunId } from "../core/trajectory.js";
import { scanSecrets } from "../security/secret-scan.js";
import { buildRunSafetyPolicy } from "./safety-policy.js";
import { executeTask } from "./task-implementations.js";

export async function runRunForge(spec: RunSpec): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const runId = createRunId();
  const runDir = join(resolve(spec.outDir), runId);
  const normalized = { ...spec, repoPath: resolve(spec.repoPath), outDir: resolve(spec.outDir) };
  await ensureDir(runDir);

  const inputScan = scanSecrets(await inputTextForScan(normalized));
  const safetyReport = buildSafetyReport(normalized.repoPath, inputScan);
  const safety = buildRunSafetyPolicy(normalized, safetyReport);
  await writeJson(join(runDir, "run-spec.json"), normalized);
  await writeJson(join(runDir, "safety-report.json"), safety);

  const taskResult = await executeTask({ spec: normalized, runDir, safety });
  const artifacts = {
    run: join(runDir, "run.json"),
    review: join(runDir, "review.md"),
    trajectory: join(runDir, "trajectory.json"),
    safetyReport: join(runDir, "safety-report.json"),
    contextSummary: join(runDir, "context-summary.json"),
    report: join(runDir, "report.md"),
    runRecord: join(runDir, "run-record.json"),
    runSpec: join(runDir, "run-spec.json"),
    ...taskResult.artifacts
  };
  const record: RunRecord = {
    runId,
    taskType: normalized.taskType,
    startedAt,
    completedAt: new Date().toISOString(),
    status: taskResult.status,
    artifacts,
    safety,
    summary: taskResult.summary
  };

  await writeJson(record.artifacts.contextSummary, buildContextSummary(normalized, record));
  await writeJson(record.artifacts.trajectory, buildRunTrajectory(normalized, record, runDir));
  await writeText(record.artifacts.review, renderRunReview(record));
  await writeText(record.artifacts.report, renderRunReport(record));
  await writeJson(record.artifacts.run, record);
  await writeJson(record.artifacts.runRecord, record);
  return record;
}

async function inputTextForScan(spec: RunSpec): Promise<string> {
  const parts = [spec.goal ?? "", spec.command ?? ""];
  if (spec.logPath) parts.push(await readText(resolve(spec.logPath)));
  return parts.join("\n");
}

function buildRunTrajectory(spec: RunSpec, record: RunRecord, runDir: string) {
  return {
    runId: record.runId,
    mode: "local",
    command: "run",
    runDir,
    taskType: spec.taskType,
    inputs: {
      repoPath: spec.repoPath,
      goal: spec.goal,
      logPath: spec.logPath,
      command: spec.command
    },
    stages: ["Run", "Task", "SafetyPolicy", "Context", "Execution", "Artifacts", "Trajectory", "Report", "HumanDecision"],
    result: {
      status: record.status,
      summary: record.summary
    }
  };
}

function buildContextSummary(spec: RunSpec, record: RunRecord) {
  return {
    runId: record.runId,
    taskType: record.taskType,
    repoPath: spec.repoPath,
    goal: spec.goal,
    logPath: spec.logPath,
    command: spec.command,
    status: record.status,
    summary: record.summary,
    artifacts: record.artifacts
  };
}

function renderRunReview(record: RunRecord): string {
  const artifacts = Object.entries(record.artifacts)
    .map(([name, path]) => `- ${name}: ${path}`)
    .join("\n");
  return `# RunForge Review

## Decision

- Task: ${record.taskType}
- Status: ${record.status}
- Human decision required: ${humanDecisionRequired(record) ? "yes" : "no"}

## Summary

${record.summary}

## Artifacts

${artifacts}
`;
}

function renderRunReport(record: RunRecord): string {
  const artifacts = Object.entries(record.artifacts)
    .map(([name, path]) => `- ${name}: ${path}`)
    .join("\n");
  return `# RunForge Run Report

## Verdict

- Run: ${record.runId}
- Task: ${record.taskType}
- Status: ${record.status}

## Summary

${record.summary}

## Artifacts

${artifacts}
`;
}

function humanDecisionRequired(record: RunRecord): boolean {
  const safety = record.safety as { humanDecisionRequired?: boolean };
  return safety.humanDecisionRequired === true || record.status === "blocked";
}
