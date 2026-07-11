import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createExecutorRequest, DockerShellExecutor, LocalShellExecutor, type ExecutorResult, type TaskRunExecutor } from "./task-run-executor.js";
import type { GitSnapshot } from "./external-command-check-types.js";
import { ownerConclusion, recommendedNextStep, remainingGaps } from "./task-run-owner-decision.js";
import { planExternalTaskRun, planTaskRun, type TaskKind } from "./task-run-planner.js";
import { writeExternalTaskRunPacket } from "./task-run-external-artifacts.js";
import { assertExternalArtifactsOutsideTarget, finishExternalTarget, prepareExternalTarget, type ExternalClassification } from "./task-run-external-target.js";
import { checkFromSubtask, completeExecutedSubtask, copyTaskWorkspace, linkExternalNodeModules, parseProviderArgs, runOwnerCheck, slug } from "./task-run-harness-helpers.js";
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

export type TaskRunRuntime = "local" | "docker";

type TaskRunInput = {
  task: string;
  out: string;
  tmpRoot?: string;
  checkCommand?: string;
  delegatedReview?: "mock" | "cli";
  runtime?: TaskRunRuntime;
  dockerImage?: string;
  repo?: string;
  commands?: string[];
  timeoutMs?: number;
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
  runtime: { mode: TaskRunRuntime; executor: "local-shell" | "docker-shell"; image: string | null };
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
  externalTarget?: {
    path: string;
    before: GitSnapshot;
    after: GitSnapshot;
    mutationVerdict: "unchanged" | "changed" | "unknown";
    commands: string[];
    capabilityClassification: ExternalClassification;
    targetClassification: ExternalClassification;
    environment: string;
    executionLog: string;
    triageReport: string;
  };
};

export async function runTaskRunHarness(input: TaskRunInput): Promise<TaskRunResult> {
  const repoRoot = process.cwd();
  const outDir = resolve(repoRoot, input.out);
  const runId = basename(outDir);
  const runtime = input.runtime ?? "local";
  const external = await prepareExternalTarget({ repo: input.repo, runtime, delegatedReview: input.delegatedReview, commands: input.commands });
  const externalRepo = external?.repo;
  const externalCommands = external?.commands ?? [];
  const defaultTmpRoot = runtime === "docker" ? join(dirname(repoRoot), ".runforge-task-runs", `${slug(basename(externalRepo ?? repoRoot))}-${slug(runId)}`) : join("/tmp", `runforge-${slug(runId)}`);
  const tmpRoot = input.tmpRoot ? resolve(input.tmpRoot) : defaultTmpRoot;
  if (externalRepo) assertExternalArtifactsOutsideTarget(externalRepo, [outDir, tmpRoot]);
  const checkCommand = externalRepo ? externalCommands.join(" && ") : input.checkCommand ?? "corepack pnpm check:structure";
  const plan = externalRepo ? planExternalTaskRun(externalCommands) : planTaskRun(input.task);
  const dockerImage = input.dockerImage ?? "runforge:local";
  const executor: TaskRunExecutor = runtime === "docker" ? new DockerShellExecutor(repoRoot, dockerImage, externalRepo) : new LocalShellExecutor(repoRoot);

  await rm(outDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(join(outDir, "subtasks"), { recursive: true });
  await mkdir(join(outDir, "review"), { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const planPath = join(outDir, "plan.md");
  await writeFile(planPath, renderPlan(runId, input.task, tmpRoot, checkCommand, plan, runtime, runtime === "docker" ? dockerImage : undefined), "utf8");

  const completedSubtasks: Array<Subtask & { workspace: string; report: string }> = [];
  for (const planned of plan.subtasks) {
    const subtaskDir = join(outDir, "subtasks", planned.id);
    const workspace = join(tmpRoot, planned.id, "workspace");
    await mkdir(subtaskDir, { recursive: true });
    const workspaceSource = externalRepo ?? repoRoot;
    await copyTaskWorkspace(workspaceSource, workspace, relative(workspaceSource, outDir));
    if (externalRepo) await linkExternalNodeModules(externalRepo, workspace);
    await writeFile(join(subtaskDir, "brief.md"), renderBrief(planned, workspace), "utf8");
    const executorRequest = createExecutorRequest({
      runId,
      subtaskId: planned.id,
      command: planned.evidenceCommand,
      cwd: workspace,
      artifactDir: subtaskDir,
      lane: executor.lane,
      timeoutMs: input.timeoutMs
    });
    const executorResult = await executor.execute(executorRequest);
    const subtask = completeExecutedSubtask(planned, executorResult);
    await writeFile(join(subtaskDir, "report.md"), renderReport(subtask, workspace), "utf8");
    completedSubtasks.push({ ...subtask, workspace, report: relative(repoRoot, join(subtaskDir, "report.md")) });
  }

  const checks = externalRepo ? completedSubtasks.map(checkFromSubtask) : [await runOwnerCheck(checkCommand, repoRoot)];
  const gaps = remainingGaps(plan.kind, input.task, runtime === "docker");
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
    checks,
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
  const evidencePassed = completedSubtasks.every((subtask) => subtask.executor.status === "passed");
  const externalFinish = external ? await finishExternalTarget(external, checks) : undefined;
  const originalUnchanged = externalFinish === undefined || externalFinish.mutationVerdict === "unchanged";
  const status = checks.every((check) => check.result === "passed") && evidencePassed && originalUnchanged && reviewResult.status !== "provider_unavailable" ? "completed" : "failed";
  const environmentPath = join(outDir, "environment.json");
  const executionLogPath = join(outDir, "execution-log.md");
  const triageReportPath = join(outDir, "external-triage-report.md");
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
    runtime: {
      mode: runtime,
      executor: executor.lane,
      image: runtime === "docker" ? dockerImage : null
    },
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
    checks,
    externalTarget: external && externalFinish ? {
      path: external.repo,
      before: external.before,
      after: externalFinish.after,
      mutationVerdict: externalFinish.mutationVerdict,
      commands: externalCommands,
      capabilityClassification: externalFinish.capabilityClassification,
      targetClassification: externalFinish.targetClassification,
      environment: relative(repoRoot, environmentPath),
      executionLog: relative(repoRoot, executionLogPath),
      triageReport: relative(repoRoot, triageReportPath)
    } : undefined
  };

  const summary = renderSummary(result);
  validateSummaryFreshness(result, summary);
  await writeFile(resultsPath, JSON.stringify(toJsonResult(result), null, 2) + "\n", "utf8");
  await writeFile(summaryPath, summary, "utf8");
  if (result.externalTarget) await writeExternalTaskRunPacket(result);
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
    `Runtime: ${result.runtime.mode}${result.runtime.image ? ` (${result.runtime.image})` : ""}`,
    ...result.checks.map((check) => `Check: ${check.command} -> ${check.result}`),
    ...(result.externalTarget ? [`Original repo: ${result.externalTarget.mutationVerdict}`, `Factory target classification: ${result.externalTarget.targetClassification}`] : [])
  ].join("\n");
}
