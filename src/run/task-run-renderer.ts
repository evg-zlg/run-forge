import type { Subtask, TaskRunResult, TaskRunRuntime } from "./task-run-harness.js";
import type { PlannedSubtask, TaskRunPlan } from "./task-run-planner.js";
import { reviewSafety } from "./task-run-review-safety.js";
import { taskRunResultContract } from "../product/task-result-contract.js";

export function renderPlan(
  runId: string,
  task: string,
  tmpRoot: string,
  checkCommand: string,
  plan: TaskRunPlan,
  runtime: TaskRunRuntime = "local",
  dockerImage?: string,
  external = false,
  preparationMode: "none" | "explicit" = "none"
): string {
  const executor = runtime === "docker" ? "DockerShellExecutor" : "LocalShellExecutor";
  const isolation = runtime === "docker" && external
    ? preparationMode === "explicit"
      ? `The original repository is not mounted. A prepared disposable workspace is mounted writable into network-disabled containers using \`${dockerImage}\`.`
      : `The original repository is mounted read-only at \`/source\`; commands run in writable disposable workspaces inside network-disabled containers using \`${dockerImage}\`.`
    : runtime === "docker"
      ? `Each subtask snapshot is mounted read-only into a network-disabled container using the prebuilt local image \`${dockerImage}\`.`
    : `Each subtask uses a disposable tmp workspace snapshot under \`${tmpRoot}/<subtask>/workspace\`.`;
  return `# ${runId} Plan

Run ID: \`${runId}\`
Date: ${new Date().toISOString().slice(0, 10)}
Mode: task-specific repeatable harness
Task kind: \`${plan.kind}\`

## Accepted Task

${task}

## Planning Basis

${plan.planningBasis.map((item) => `- ${item}`).join("\n")}

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add scheduler, provider routing, daemon, provider catalog, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

${plan.inputs.map((item) => `- \`${item}\``).join("\n")}

## Decomposition

${plan.subtasks.map((item, index) => `${index + 1}. \`${item.id}\`: ${item.goal}`).join("\n")}

## Evidence Commands

${plan.subtasks.map((item) => `- \`${item.id}\`: \`${item.evidenceCommand}\``).join("\n")}

## Executor

Each subtask evidence command is dispatched through \`${executor}\` as an executor request. The executor writes \`command.log\`, \`stdout.log\`, \`stderr.log\`, and \`executor-report.json\` into the subtask artifact directory.

## Isolation

${isolation}

## Checks

\`\`\`bash
${checkCommand}
\`\`\`
`;
}

export function renderBrief(subtask: PlannedSubtask, workspace: string): string {
  return `# ${subtask.id} Brief

Goal: ${subtask.goal}

Workspace path: \`${workspace}\`

Inputs to inspect:
${subtask.inputs.map((item) => `- \`${item}\``).join("\n")}

Evidence command:
\`\`\`bash
${subtask.evidenceCommand}
\`\`\`

Required output: \`report.md\` with status, findings, command evidence, and artifacts.
`;
}

export function renderReport(subtask: Subtask, workspace: string): string {
  return `# ${subtask.id} Report

Subtask id: \`${subtask.id}\`

Goal: ${subtask.goal}

Workspace path: \`${workspace}\`

Inputs inspected:
${subtask.inputs.map((item) => `- \`${item}\``).join("\n")}

Findings:
${subtask.findings.map((item) => `- ${item}`).join("\n")}

Evidence:
- Command: \`${subtask.evidence.command}\`
- Status: ${subtask.evidence.status}
- Exit code: ${subtask.evidence.exitCode}
- Log: \`${subtask.evidence.logPath}\`
- Executor: ${subtask.executor.executor}
- Executor request: \`${subtask.executor.requestId}\`
- Executor report: \`${subtask.evidence.executorReport}\`
- Stdout log: \`${subtask.executor.artifactPaths.stdoutLog}\`
- Stderr log: \`${subtask.executor.artifactPaths.stderrLog}\`

Status: ${subtask.status}

Artifacts:
${subtask.artifacts.map((item) => `- \`${item}\``).join("\n")}
`;
}

export function renderSummary(result: TaskRunResult): string {
  return `# ${result.runId} Summary

Final verdict: ${result.status === "completed" ? "task-specific task-run completed" : "task-run completed with failed checks"}.

## Accepted Task

${result.task}

Task kind: \`${result.taskKind}\`

## Deterministic Facts

- Task kind: \`${result.taskKind}\`
- Plan artifact: \`${result.plan}\`
- Results artifact: \`${result.results}\`
- Subtask artifact root: \`${result.outDir}/subtasks/\`
- Executor lane: \`${result.runtime.executor}\`
- Runtime mode: \`${result.runtime.mode}\`${result.runtime.image ? ` with image \`${result.runtime.image}\`` : ""}
- Source repository: \`${result.sourceRepository.before?.path ?? "current RunForge checkout"}\`
- Runtime preparation mode: \`${result.preparationMode}\`
- Review lane: \`${result.review.resultPayload.reviewer}\` using \`${result.review.resultPayload.provider}\`
- Recommended next milestone: \`${result.selectedMilestone}\`

## Delegated Review

- Review status: \`${result.review.resultPayload.status}\`
- Confidence: \`${result.review.resultPayload.confidence}\`
- Human decision required: ${result.review.resultPayload.humanDecisionRequired ? "yes" : "no"}
- Review request: \`${result.review.request}\`
- Review result: \`${result.review.result}\`
- Review markdown: \`${result.review.markdown}\`
${result.review.providerMetadata ? `- Provider review metadata: \`${result.review.providerMetadata}\`` : "- Provider review metadata: n/a (providerless default)"}

${result.review.resultPayload.findings.map((item) => `- ${item.severity}: ${item.message}`).join("\n")}

## Safety Gate

- Source mutation detected: ${result.safety.sourceMutationDetected ? "yes" : "no"}
- Blocking safety failures: ${result.safety.blockingFailures.length}
${result.safety.blockingFailures.map((item) => `- ${item}`).join("\n")}

## Owner Decision

${result.ownerConclusion}

${result.recommendedNextStep}

## Planning Basis

${result.planningBasis.map((item) => `- ${item}`).join("\n")}

## Current Command

- \`${taskRunCommand(result)}\`

## Artifacts Created

- \`${result.plan}\`
- \`${result.results}\`
- \`${result.summary}\`
- \`${result.review.request}\`
- \`${result.review.result}\`
- \`${result.review.markdown}\`
${result.review.providerMetadata ? `- \`${result.review.providerMetadata}\`` : ""}
- \`${result.outDir}/subtasks/\`

## Isolation Method

Disposable tmp workspace snapshots were created under \`${result.tmpRoot}\`.

${result.subtasks.map((item) => `- \`${item.id}\`: \`${item.workspace}\``).join("\n")}

${result.runtime.mode === "docker"
  ? result.sourceRepository.external
    ? result.preparationMode === "explicit"
      ? `The original repository was never mounted. The prepared disposable workspace was mounted writable into network-disabled containers using \`${result.runtime.image}\` so tests and builds could create temporary/output files.`
      : `The original repository was mounted read-only at \`/source\`; commands ran in writable disposable workspaces using \`${result.runtime.image}\` with network disabled.`
    : `Each snapshot was mounted read-only into a network-disabled container using \`${result.runtime.image}\`.`
  : "Container isolation was not selected; execution used the local host process lane."}

## Executor Dispatch

Subtasks were dispatched through \`${result.runtime.executor}\`; planner output was converted into executor requests, and aggregation used executor results.

${result.subtasks.map((item) => `- \`${item.id}\`: request \`${item.executor.requestId}\` -> ${item.executor.status}; report \`${item.executor.artifactPaths.report}\``).join("\n")}

## Subtask Results

${result.subtasks.map((item) => `- \`${item.id}\`: ${item.findings.join(" ")}`).join("\n")}

## Checks

${result.checks.map((check) => `- \`${check.command}\`: ${check.result}`).join("\n")}

## Evidence Captured

${result.subtasks.map((item) => `- \`${item.id}\`: \`${item.evidence.command}\` -> ${item.evidence.status}; log \`${item.evidence.logPath}\`; executor report \`${item.evidence.executorReport}\``).join("\n")}

## Remaining Gaps

${result.gaps.map((gap) => `- ${gap}`).join("\n")}

## Recommended Next Milestone

${result.recommendedNextStep}
`;
}

export function validateSummaryFreshness(result: TaskRunResult, summary: string): void {
  const expectedCommand = taskRunCommand(result);
  const missing = [
    summary.includes(result.runId) ? null : "current run id",
    summary.includes(result.task) ? null : "current task text",
    summary.includes(expectedCommand) ? null : "current task-run command"
  ].filter((item): item is string => item !== null);

  if (missing.length > 0) {
    throw new Error(`Task-run summary is missing ${missing.join(", ")}.`);
  }
}

function taskRunCommand(result: TaskRunResult): string {
  const mode = result.review.providerMetadataPayload?.mode;
  const delegated = mode === "delegated-cli" ? " --delegated-review cli" : mode === "delegated-mock" ? " --delegated-review mock" : "";
  const runtime = result.runtime.mode === "docker" ? ` --runtime docker --docker-image ${result.runtime.image}` : "";
  const repo = result.sourceRepository.external ? ` --repo ${result.sourceRepository.before?.path}` : "";
  const preparation = result.sourceRepository.external ? ` --prepare-runtime ${result.preparationMode}` : "";
  const commands = result.sourceRepository.external ? result.subtasks.map((item) => ` --command "${item.evidence.command}"`).join("") : "";
  const check = ` --check-command "${result.checks[0]?.command}"`;
  return `corepack pnpm dev task-run start --task "${result.task}" --out ${result.outDir}${repo}${runtime}${preparation}${commands}${check}${delegated}`;
}

export function toJsonResult(result: TaskRunResult, taskId = result.runId): unknown {
  return {
    ...taskRunResultContract(result, taskId),
    runId: result.runId,
    date: new Date().toISOString().slice(0, 10),
    taskAccepted: result.task,
    taskKind: result.taskKind,
    planningBasis: result.planningBasis,
    mode: "task-specific repeatable harness",
    status: result.status,
    artifacts: {
      plan: result.plan,
      summary: result.summary,
      results: result.results,
      reviewRequest: result.review.request,
      reviewResult: result.review.result,
      reviewMarkdown: result.review.markdown,
      providerReviewMetadata: result.review.providerMetadata ?? null,
      subtasks: `${result.outDir}/subtasks/`
    },
    isolation: {
      method: result.runtime.mode === "docker"
        ? result.sourceRepository.external
          ? `${result.preparationMode} external Docker mode with writable disposable workspace`
          : "read-only Docker container over disposable tmp workspace snapshot"
        : "disposable tmp workspace snapshots",
      root: result.tmpRoot,
      containerUsed: result.runtime.mode === "docker",
      image: result.runtime.image,
      network: result.runtime.mode === "docker" ? "none" : "host"
    },
    sourceRepository: result.sourceRepository,
    preparationMode: result.preparationMode,
    preparation: result.preparation,
    safety: result.safety,
    selectedMilestone: result.selectedMilestone,
    executor: {
      lane: result.runtime.executor,
      dispatch: "planner subtasks are converted into executor requests before command execution"
    },
    subtasks: result.subtasks.map((item) => ({
      id: item.id,
      goal: item.goal,
      workspace: item.workspace,
      inputsInspected: item.inputs,
      findings: item.findings,
      status: item.status,
      artifacts: item.artifacts,
      evidence: item.evidence,
      executor: {
        requestId: item.executor.requestId,
        lane: item.executor.executor,
        runtime: item.executor.runtime,
        status: item.executor.status,
        exitCode: item.executor.exitCode,
        signal: item.executor.signal,
        timedOut: item.executor.timedOut,
        artifactPaths: item.executor.artifactPaths
      },
      report: item.report
    })),
    checks: result.checks.map((check) => ({
      command: check.command,
      result: check.result,
      exitCode: check.exitCode
    })),
    review: {
      request: result.review.request,
      result: result.review.result,
      markdown: result.review.markdown,
      reviewer: result.review.resultPayload.reviewer,
      provider: result.review.resultPayload.provider,
      providerMetadata: result.review.providerMetadata ?? null,
      safety: reviewSafety(result),
      status: result.review.resultPayload.status,
      confidence: result.review.resultPayload.confidence,
      humanDecisionRequired: result.review.resultPayload.humanDecisionRequired,
      recommendedNextAction: result.review.resultPayload.recommendedNextAction,
      evidenceReferences: result.review.resultPayload.evidenceReferences
    },
    ownerConclusion: result.ownerConclusion,
    remainingGaps: result.gaps,
    recommendedNextMilestone: result.selectedMilestone,
    recommendedNextStep: result.recommendedNextStep
  };
}
