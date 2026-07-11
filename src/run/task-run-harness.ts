import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createExecutorRequest, LocalShellExecutor, type ExecutorResult } from "./task-run-executor.js";
import { ownerConclusion, recommendedNextStep, remainingGaps } from "./task-run-owner-decision.js";
import { planTaskRun, type PlannedSubtask, type TaskKind } from "./task-run-planner.js";
import {
  buildReviewRequest,
  buildProviderReviewMetadata,
  CliDelegatedEvidenceReviewer,
  DeterministicEvidenceReviewer,
  MockDelegatedEvidenceReviewer,
  renderReviewMarkdown,
  writeProviderInputPackage,
  type ProviderReviewMetadata,
  type ReviewRequest,
  type ReviewResult
} from "./task-run-reviewer.js";
import { renderBrief, renderPlan, renderReport, renderSummary, toJsonResult, validateSummaryFreshness } from "./task-run-renderer.js";

const execFileAsync = promisify(execFile);

type TaskRunInput = {
  task: string;
  out: string;
  tmpRoot?: string;
  checkCommand?: string;
  delegatedReview?: "mock" | "cli";
};

export type Subtask = {
  id: string;
  goal: string;
  inputs: string[];
  findings: string[];
  status: "done";
  artifacts: string[];
  evidence: EvidenceRecord;
  executor: ExecutorResult;
};

export type CheckResult = {
  command: string;
  result: "passed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type EvidenceRecord = {
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  logPath: string;
  inspected: string[];
  summary: string;
  executorReport: string;
};

export type TaskRunResult = {
  runId: string;
  task: string;
  taskKind: TaskKind;
  planningBasis: string[];
  selectedMilestone: string;
  ownerConclusion: string;
  recommendedNextStep: string;
  gaps: string[];
  status: "completed" | "failed";
  outDir: string;
  tmpRoot: string;
  plan: string;
  summary: string;
  results: string;
  review: {
    request: string;
    result: string;
    markdown: string;
    providerMetadata?: string;
    requestPayload: ReviewRequest;
    resultPayload: ReviewResult;
    providerMetadataPayload?: ProviderReviewMetadata;
  };
  subtasks: Array<Subtask & { workspace: string; report: string }>;
  checks: CheckResult[];
};

export async function runTaskRunHarness(input: TaskRunInput): Promise<TaskRunResult> {
  const repoRoot = process.cwd();
  const outDir = resolve(repoRoot, input.out);
  const runId = basename(outDir);
  const tmpRoot = input.tmpRoot ? resolve(input.tmpRoot) : join("/tmp", `runforge-${slug(runId)}`);
  const checkCommand = input.checkCommand ?? "corepack pnpm check:structure";
  const plan = planTaskRun(input.task);
  const executor = new LocalShellExecutor(repoRoot);

  await rm(outDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(join(outDir, "subtasks"), { recursive: true });
  await mkdir(join(outDir, "review"), { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const planPath = join(outDir, "plan.md");
  await writeFile(planPath, renderPlan(runId, input.task, tmpRoot, checkCommand, plan), "utf8");

  const completedSubtasks: Array<Subtask & { workspace: string; report: string }> = [];
  for (const planned of plan.subtasks) {
    const subtaskDir = join(outDir, "subtasks", planned.id);
    const workspace = join(tmpRoot, planned.id, "workspace");
    await mkdir(subtaskDir, { recursive: true });
    await copyWorkspace(repoRoot, workspace, relative(repoRoot, outDir));
    await writeFile(join(subtaskDir, "brief.md"), renderBrief(planned, workspace), "utf8");
    const executorRequest = createExecutorRequest({
      runId,
      subtaskId: planned.id,
      command: planned.evidenceCommand,
      cwd: workspace,
      artifactDir: subtaskDir
    });
    const executorResult = await executor.execute(executorRequest);
    const evidence = toEvidenceRecord(planned, executorResult);
    const subtask = completeSubtask(planned, evidence, executorResult);
    await writeFile(join(subtaskDir, "report.md"), renderReport(subtask, workspace), "utf8");
    completedSubtasks.push({ ...subtask, workspace, report: relative(repoRoot, join(subtaskDir, "report.md")) });
  }

  const check = await runCheck(checkCommand, repoRoot);
  const gaps = remainingGaps(plan.kind, input.task);
  const reviewDir = join(outDir, "review");
  const reviewRequestPath = join(reviewDir, "review-request.json");
  const reviewResultPath = join(reviewDir, "review-result.json");
  const reviewMarkdownPath = join(reviewDir, "review.md");
  const providerReviewMetadataPath = join(reviewDir, "provider-review-metadata.json");
  const providerInputJsonPath = join(reviewDir, "provider-input.json");
  const providerInputMarkdownPath = join(reviewDir, "provider-input.md");
  const reviewRequest = buildReviewRequest({
    runId,
    acceptedTask: input.task,
    taskKind: plan.kind,
    plan,
    subtasks: completedSubtasks,
    checks: [check],
    gaps
  });
  const providerInput =
    input.delegatedReview === "mock" || input.delegatedReview === "cli"
      ? await writeProviderInputPackage({
          request: reviewRequest,
          repoRoot,
          jsonPath: providerInputJsonPath,
          markdownPath: providerInputMarkdownPath
        })
      : undefined;
  const reviewer =
    input.delegatedReview === "mock"
      ? new MockDelegatedEvidenceReviewer()
      : input.delegatedReview === "cli"
        ? new CliDelegatedEvidenceReviewer({
            providerInputJsonPath: "provider-input.json",
            providerInputMarkdownPath: "provider-input.md",
            reviewDir,
            providerCommand: process.env.RUNFORGE_TASK_RUN_REVIEWER_CLI,
            providerArgs: parseProviderArgs(process.env.RUNFORGE_TASK_RUN_REVIEWER_ARGS),
            model: process.env.RUNFORGE_TASK_RUN_REVIEWER_MODEL
          })
        : new DeterministicEvidenceReviewer();
  const reviewResult = await reviewer.review(reviewRequest);
  const relativeReviewRequestPath = relative(repoRoot, reviewRequestPath);
  const relativeReviewResultPath = relative(repoRoot, reviewResultPath);
  const relativeReviewMarkdownPath = relative(repoRoot, reviewMarkdownPath);
  const relativeProviderReviewMetadataPath = relative(repoRoot, providerReviewMetadataPath);
  const relativeProviderInputJsonPath = relative(repoRoot, providerInputJsonPath);
  const relativeProviderInputMarkdownPath = relative(repoRoot, providerInputMarkdownPath);
  const providerMetadata = input.delegatedReview
    ? buildProviderReviewMetadata({
        mode: input.delegatedReview === "cli" ? "delegated-cli" : "delegated-mock",
        provider: reviewResult.provider,
        reviewer: reviewResult.reviewer,
        explicitFlagProvided: true,
        adapterName: input.delegatedReview === "cli" ? "task-run-cli-reviewer" : undefined,
        model: input.delegatedReview === "cli" ? (process.env.RUNFORGE_TASK_RUN_REVIEWER_MODEL ?? null) : null,
        networkUsed: input.delegatedReview === "cli" && reviewResult.status !== "provider_unavailable",
        inputBytes: providerInput?.inputBytes,
        inputTruncated: providerInput?.inputTruncated,
        reviewRequestPath: relativeReviewRequestPath,
        reviewResultPath: relativeReviewResultPath,
        reviewMarkdownPath: relativeReviewMarkdownPath,
        providerInputJsonPath: relativeProviderInputJsonPath,
        providerInputMarkdownPath: relativeProviderInputMarkdownPath,
        evidenceReferences: reviewResult.evidenceReferences
      })
    : undefined;
  await writeFile(reviewRequestPath, JSON.stringify(reviewRequest, null, 2) + "\n", "utf8");
  await writeFile(reviewResultPath, JSON.stringify(reviewResult, null, 2) + "\n", "utf8");
  await writeFile(reviewMarkdownPath, renderReviewMarkdown(reviewRequest, reviewResult), "utf8");
  if (providerMetadata) {
    await writeFile(providerReviewMetadataPath, JSON.stringify(providerMetadata, null, 2) + "\n", "utf8");
  }

  const resultsPath = join(outDir, "results.json");
  const summaryPath = join(outDir, "summary.md");
  const status = check.result === "passed" && reviewResult.status !== "provider_unavailable" ? "completed" : "failed";
  const result: TaskRunResult = {
    runId,
    task: input.task,
    taskKind: plan.kind,
    planningBasis: plan.planningBasis,
    selectedMilestone: plan.recommendedNextMilestone,
    ownerConclusion: ownerConclusion(input.task, plan.kind),
    recommendedNextStep: recommendedNextStep(plan.recommendedNextMilestone),
    gaps,
    status,
    outDir: relative(repoRoot, outDir),
    tmpRoot,
    plan: relative(repoRoot, planPath),
    summary: relative(repoRoot, summaryPath),
    results: relative(repoRoot, resultsPath),
    review: {
      request: relativeReviewRequestPath,
      result: relativeReviewResultPath,
      markdown: relativeReviewMarkdownPath,
      providerMetadata: providerMetadata ? relativeProviderReviewMetadataPath : undefined,
      requestPayload: reviewRequest,
      resultPayload: reviewResult,
      providerMetadataPayload: providerMetadata
    },
    subtasks: completedSubtasks,
    checks: [check]
  };

  const summary = renderSummary(result);
  validateSummaryFreshness(result, summary);
  await writeFile(resultsPath, JSON.stringify(toJsonResult(result), null, 2) + "\n", "utf8");
  await writeFile(summaryPath, summary, "utf8");
  return result;
}

export function renderTaskRunCliSummary(result: TaskRunResult): string {
  return [
    `Task run ${result.status}: ${result.runId}`,
    `Plan: ${result.plan}`,
    `Summary: ${result.summary}`,
    `Results: ${result.results}`,
    `Review: ${result.review.markdown}`,
    `Tmp isolation root: ${result.tmpRoot}`,
    `Check: ${result.checks[0]?.command} -> ${result.checks[0]?.result}`
  ].join("\n");
}

async function copyWorkspace(repoRoot: string, workspace: string, outPath: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await cp(repoRoot, workspace, {
    recursive: true,
    filter: (source) => {
      const path = relative(repoRoot, source);
      if (!path) return true;
      return !shouldSkipSnapshotPath(path, outPath);
    }
  });
}

function shouldSkipSnapshotPath(path: string, outPath: string): boolean {
  const first = path.split("/")[0];
  if (path === outPath || path.startsWith(`${outPath}/`)) return true;
  return first === "node_modules" || first === "dist" || first === ".git" || first === "artifacts" || first === "runforge-artifacts";
}

async function runCheck(command: string, cwd: string): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], { cwd, maxBuffer: 1024 * 1024 * 8 });
    return { command, result: "passed", exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      command,
      result: "failed",
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? ""
    };
  }
}

function toEvidenceRecord(subtask: PlannedSubtask, result: ExecutorResult): EvidenceRecord {
  return {
    command: subtask.evidenceCommand,
    status: result.status,
    exitCode: result.exitCode,
    logPath: result.artifactPaths.commandLog,
    inspected: subtask.inputs,
    summary: summarizeEvidence(subtask, result),
    executorReport: result.artifactPaths.report
  };
}

function completeSubtask(subtask: PlannedSubtask, evidence: EvidenceRecord, executor: ExecutorResult): Subtask {
  return {
    id: subtask.id,
    goal: subtask.goal,
    inputs: subtask.inputs,
    findings: [
      `${subtask.evidenceFocus} Evidence command ${evidence.status} with exit code ${evidence.exitCode}.`,
      evidence.summary
    ],
    status: "done",
    artifacts: ["brief.md", "report.md", "command.log", "stdout.log", "stderr.log", "executor-report.json"],
    evidence,
    executor
  };
}

function summarizeEvidence(subtask: PlannedSubtask, result: ExecutorResult): string {
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sample = lines.slice(0, 3).join(" | ");
  if (lines.length === 0) return `${subtask.id} produced no stdout; inspect ${subtask.inputs.join(", ")} manually.`;
  return `${subtask.id} inspected ${subtask.inputs.length} input(s) and captured ${lines.length} stdout line(s). Sample: ${sample}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseProviderArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    return [];
  }
  return [];
}
