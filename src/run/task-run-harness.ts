import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createExecutorRequest, DockerShellExecutor, LocalShellExecutor, type ExecutorResult, type TaskRunExecutor } from "./task-run-executor.js";
import { ownerConclusion, recommendedNextStep, remainingGaps } from "./task-run-owner-decision.js";
import { assertExternalPathsOutsideTarget, assertExternalTaskPolicy } from "./task-run-external-target.js";
import { writeExternalReadinessArtifacts } from "./external-readiness-artifacts.js";
import { planExternalValidationTaskRun, planTaskRun, type PlannedSubtask, type TaskKind } from "./task-run-planner.js";
import { detectLockfileName, inspectRepoState, prepareExternalRuntime, type RepoState, type RuntimePreparationResult } from "./runtime-preparation.js";
import { sourceImmutabilityCheck, taskRunCompletionStatus } from "./task-run-source-safety.js";
import { completeExecutedSubtask, parseProviderArgs, runOwnerCheck } from "./task-run-harness-helpers.js";
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
import { copyTaskRunWorkspace, prepareUnpreparedExternalWorkspace, taskRunSlug } from "./task-run-workspace.js";
import { validateTaskResultContract } from "../product/task-result-contract.js";

export type TaskRunRuntime = "local" | "docker";

type TaskRunInput = {
  taskId?: string;
  executionRoot?: string;
  forceExternal?: boolean;
  task: string;
  out: string;
  tmpRoot?: string;
  checkCommand?: string;
  delegatedReview?: "mock" | "cli";
  runtime?: TaskRunRuntime;
  dockerImage?: string;
  repo?: string;
  commands?: string[];
  prepareRuntime?: "none" | "explicit";
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
  sourceRepository: { external: boolean; before: RepoState | null; after: RepoState | null; unchanged: boolean | null };
  preparationMode: "none" | "explicit";
  preparation: RuntimePreparationResult | null;
  safety: { sourceMutationDetected: boolean; blockingFailures: string[] };
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
  const repoRoot = resolve(input.executionRoot ?? process.cwd());
  const sourceRoot = input.repo ? resolve(input.repo) : repoRoot;
  const external = input.forceExternal === true || sourceRoot !== repoRoot;
  const outDir = resolve(repoRoot, input.out);
  const runId = basename(outDir);
  const runtime = input.runtime ?? "local";
  const defaultTmpRoot = runtime === "docker" ? join(dirname(repoRoot), ".runforge-task-runs", `${taskRunSlug(basename(repoRoot))}-${taskRunSlug(runId)}`) : join("/tmp", `runforge-${taskRunSlug(runId)}`);
  const tmpRoot = input.tmpRoot ? resolve(input.tmpRoot) : defaultTmpRoot;
  const checkCommand = input.checkCommand ?? "corepack pnpm check:structure";
  const dockerImage = input.dockerImage ?? "runforge:local";
  const prepareRuntime = input.prepareRuntime ?? "none";
  const externalCommands = input.commands ?? [];
  if (external) await assertExternalTaskPolicy({ repo: sourceRoot, runtime, delegatedReview: input.delegatedReview, commands: externalCommands });
  if (prepareRuntime === "explicit" && (!external || runtime !== "docker")) {
    throw new Error("--prepare-runtime explicit requires --repo and --runtime docker.");
  }
  const preparationWorkspace = join(tmpRoot, "prepared-workspace");
  const plan = external ? planExternalValidationTaskRun(input.task, await detectLockfileName(sourceRoot), externalCommands) : planTaskRun(input.task);
  if (external) {
    await assertExternalPathsOutsideTarget(sourceRoot, [
      outDir,
      tmpRoot,
      preparationWorkspace,
      ...plan.subtasks.map((item) => join(tmpRoot, item.id, "workspace"))
    ]);
  }
  const sourceBefore = external ? await inspectRepoState(sourceRoot) : null;
  const readonlyDependencies = external && prepareRuntime === "none" && sourceBefore?.path
    ? await access(join(sourceBefore.path, "node_modules")).then(() => join(sourceBefore.path, "node_modules"), () => undefined)
    : undefined;
  const executor: TaskRunExecutor = runtime === "docker" ? new DockerShellExecutor(repoRoot, dockerImage, external, readonlyDependencies) : new LocalShellExecutor(repoRoot);

  await rm(outDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(join(outDir, "subtasks"), { recursive: true });
  await mkdir(join(outDir, "review"), { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const preparation = prepareRuntime === "explicit"
    ? await prepareExternalRuntime({ repo: sourceRoot, workspace: preparationWorkspace, outDir, image: dockerImage }) : null;
  const planPath = join(outDir, "plan.md");
  await writeFile(planPath, renderPlan(runId, input.task, tmpRoot, checkCommand, plan, runtime, runtime === "docker" ? dockerImage : undefined, external, prepareRuntime), "utf8");

  const completedSubtasks: Array<Subtask & { workspace: string; report: string }> = [];
  for (const planned of plan.subtasks) {
    const subtaskDir = join(outDir, "subtasks", planned.id);
    const workspace = preparation ? preparation.workspace : join(tmpRoot, planned.id, "workspace");
    await mkdir(subtaskDir, { recursive: true });
    if (!preparation) {
      await copyTaskRunWorkspace(sourceRoot, workspace, external ? "" : relative(repoRoot, outDir));
      if (external) await prepareUnpreparedExternalWorkspace(sourceRoot, workspace);
    }
    await writeFile(join(subtaskDir, "brief.md"), renderBrief(planned, workspace), "utf8");
    const executorRequest = createExecutorRequest({
      runId,
      subtaskId: planned.id,
      command: planned.evidenceCommand,
      cwd: workspace,
      artifactDir: subtaskDir,
      lane: executor.lane,
      timeoutMs: external ? (input.timeoutMs ?? 300_000) : undefined
    });
    const executorResult = await executor.execute(executorRequest);
    const subtask = completeExecutedSubtask(planned, executorResult);
    await writeFile(join(subtaskDir, "report.md"), renderReport(subtask, workspace), "utf8");
    completedSubtasks.push({ ...subtask, workspace, report: relative(repoRoot, join(subtaskDir, "report.md")) });
  }

  const check = await runOwnerCheck(checkCommand, repoRoot);
  const sourceAfter = external ? await inspectRepoState(sourceRoot) : null;
  const sourceUnchanged = sourceBefore && sourceAfter
    ? sourceBefore.head === sourceAfter.head && sourceBefore.status === sourceAfter.status
    : null;
  const sourceCheck = sourceImmutabilityCheck(external, sourceBefore, sourceAfter);
  const checks = sourceCheck ? [check, sourceCheck] : [check];
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
  const status = taskRunCompletionStatus({ checks, evidencePassed, reviewStatus: reviewResult.status });
  const blockingFailures = checks.filter((item) => item.result === "failed").map((item) => item.stderr.trim() || `${item.command} failed.`);
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
    sourceRepository: { external, before: sourceBefore, after: sourceAfter, unchanged: sourceUnchanged },
    preparationMode: prepareRuntime,
    preparation,
    safety: { sourceMutationDetected: external && sourceUnchanged !== true, blockingFailures },
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
    checks
  };

  const summary = renderSummary(result);
  validateSummaryFreshness(result, summary);
  const resultDocument = toJsonResult(result, input.taskId);
  validateTaskResultContract(resultDocument);
  await writeFile(resultsPath, JSON.stringify(resultDocument, null, 2) + "\n", "utf8");
  await writeFile(summaryPath, summary, "utf8");
  if (external) await writeExternalReadinessArtifacts(result, repoRoot);
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
    `Check: ${result.checks[0]?.command} -> ${result.checks[0]?.result}`
  ].join("\n");
}
