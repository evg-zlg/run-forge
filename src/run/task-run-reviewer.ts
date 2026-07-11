import type { CheckResult, Subtask } from "./task-run-harness.js";
import type { TaskKind, TaskRunPlan } from "./task-run-planner.js";

export { CliDelegatedEvidenceReviewer } from "./task-run-cli-reviewer.js";
export { writeProviderInputPackage, type ProviderInputPackage } from "./task-run-provider-input.js";

export type ReviewStatus = "accepted" | "needs_attention" | "blocked" | "provider_unavailable";
export type ReviewConfidence = "high" | "medium" | "low";
export type ReviewProvider = "providerless" | "mock" | "cli";
export type ReviewMode = "providerless" | "delegated-mock" | "delegated-cli";

export type ReviewRequest = {
  runId: string;
  acceptedTask: string;
  taskKind: TaskKind;
  plan: TaskRunPlan;
  subtaskReports: Array<{
    id: string;
    goal: string;
    reportPath: string;
    findings: string[];
    status: Subtask["status"];
  }>;
  executorResults: Array<{
    subtaskId: string;
    requestId: string;
    executor: Subtask["executor"]["executor"];
    status: Subtask["executor"]["status"];
    exitCode: number | null;
    timedOut: boolean;
  }>;
  commandStatuses: Array<{
    subtaskId: string;
    command: string;
    status: Subtask["evidence"]["status"];
    exitCode: number | null;
  }>;
  logPaths: Array<{
    subtaskId: string;
    commandLog: string;
    stdoutLog: string;
    stderrLog: string;
    executorReport: string;
  }>;
  checks: Array<Pick<CheckResult, "command" | "result" | "exitCode">>;
  gaps: string[];
};

export type ReviewFinding = {
  severity: "info" | "warning" | "error";
  message: string;
  evidenceReferences: string[];
};

export type ReviewResult = {
  reviewer: "deterministic-evidence-reviewer" | "mock-delegated-evidence-reviewer" | "cli-delegated-evidence-reviewer";
  provider: ReviewProvider;
  status: ReviewStatus;
  confidence: ReviewConfidence;
  findings: ReviewFinding[];
  risks: string[];
  recommendedNextAction: string;
  evidenceReferences: string[];
  humanDecisionRequired: boolean;
};

export type ProviderReviewMetadata = {
  mode: ReviewMode;
  providerMode: ReviewMode;
  provider: ReviewProvider;
  adapterName: string;
  model: string | null;
  reviewer: ReviewResult["reviewer"];
  explicitFlagRequired: boolean;
  explicitFlagProvided: boolean;
  reviewOnly: true;
  readOnly: true;
  mutationForbidden: true;
  autoApplyForbidden: true;
  networkAccess: "not_requested" | "not_used" | "external_cli_invoked";
  networkUsed: boolean;
  secretsAccess: "not_requested";
  secretsRequested: false;
  repoAccess: "evidence_packet_only";
  inputBytes: number;
  inputTruncated: boolean;
  truncationStatus: "not_truncated" | "truncated";
  inputArtifacts: string[];
  outputArtifacts: string[];
};

export type TaskRunReviewer = {
  review(request: ReviewRequest): Promise<ReviewResult>;
};

export class DeterministicEvidenceReviewer implements TaskRunReviewer {
  async review(request: ReviewRequest): Promise<ReviewResult> {
    const failedCommands = request.commandStatuses.filter((item) => item.status !== "passed");
    const failedChecks = request.checks.filter((item) => item.result !== "passed");
    const missingReports = request.subtaskReports.filter((item) => item.status !== "done" || item.reportPath.length === 0);
    const evidenceReferences = unique([
      ...request.subtaskReports.map((item) => item.reportPath),
      ...request.logPaths.flatMap((item) => [item.commandLog, item.stdoutLog, item.stderrLog, item.executorReport])
    ]);

    const findings: ReviewFinding[] = [
      {
        severity: "info",
        message: `Reviewed ${request.subtaskReports.length} subtask report(s), ${request.commandStatuses.length} command status record(s), and ${request.checks.length} owner check(s).`,
        evidenceReferences: evidenceReferences.slice(0, 6)
      },
      {
        severity: failedCommands.length === 0 ? "info" : "error",
        message:
          failedCommands.length === 0
            ? "All subtask evidence commands completed successfully."
            : `${failedCommands.length} subtask evidence command(s) did not pass.`,
        evidenceReferences: referencesForSubtasks(failedCommands.map((item) => item.subtaskId), request)
      },
      {
        severity: failedChecks.length === 0 ? "info" : "warning",
        message: failedChecks.length === 0 ? "The owner check passed." : `${failedChecks.length} owner check(s) failed.`,
        evidenceReferences: failedChecks.map((item) => item.command)
      }
    ];

    if (missingReports.length > 0) {
      findings.push({
        severity: "error",
        message: `${missingReports.length} subtask report artifact(s) are missing or incomplete.`,
        evidenceReferences: missingReports.map((item) => item.id)
      });
    }

    const status: ReviewStatus =
      failedCommands.length > 0 || missingReports.length > 0 ? "blocked" : failedChecks.length > 0 ? "needs_attention" : "accepted";

    return {
      reviewer: "deterministic-evidence-reviewer",
      provider: "providerless",
      status,
      confidence: status === "accepted" && request.gaps.length <= 1 ? "high" : failedCommands.length > 0 ? "low" : "medium",
      findings,
      risks: request.gaps.length > 0 ? request.gaps : ["No additional deterministic gaps were reported by the harness."],
      recommendedNextAction:
        status === "accepted"
          ? "Owner can use the summary and review artifacts as evidence for the next milestone decision."
          : "Owner should inspect failed command/check evidence before treating this run as complete.",
      evidenceReferences,
      humanDecisionRequired: status !== "accepted" || request.gaps.length > 0
    };
  }
}

export class MockDelegatedEvidenceReviewer implements TaskRunReviewer {
  async review(request: ReviewRequest): Promise<ReviewResult> {
    const deterministic = await new DeterministicEvidenceReviewer().review(request);
    return {
      ...deterministic,
      reviewer: "mock-delegated-evidence-reviewer",
      provider: "mock",
      confidence: deterministic.confidence === "low" ? "low" : "medium",
      findings: [
        ...deterministic.findings,
        {
          severity: "info",
          message:
            "Mock delegated review consumed the evidence packet only and proved the provider review contract without network, secrets, repo mutation, or patch output.",
          evidenceReferences: ["review/review-request.json", ...request.logPaths.map((item) => item.executorReport)]
        }
      ],
      recommendedNextAction:
        deterministic.status === "accepted"
          ? "Owner can use the delegated mock review as contract proof, then decide whether to wire a real read-only provider behind the same gate."
          : deterministic.recommendedNextAction
    };
  }
}

export function buildProviderReviewMetadata(input: {
  mode: ReviewMode;
  provider: ReviewProvider;
  reviewer: ReviewResult["reviewer"];
  explicitFlagProvided: boolean;
  adapterName?: string;
  model?: string | null;
  networkUsed?: boolean;
  inputBytes?: number;
  inputTruncated?: boolean;
  reviewRequestPath: string;
  reviewResultPath: string;
  reviewMarkdownPath: string;
  providerInputJsonPath?: string;
  providerInputMarkdownPath?: string;
  evidenceReferences: string[];
}): ProviderReviewMetadata {
  const networkUsed = input.networkUsed ?? false;
  const inputTruncated = input.inputTruncated ?? false;
  return {
    mode: input.mode,
    providerMode: input.mode,
    provider: input.provider,
    adapterName: input.adapterName ?? (input.provider === "mock" ? "mock-delegated-evidence-reviewer" : "deterministic-evidence-reviewer"),
    model: input.model ?? null,
    reviewer: input.reviewer,
    explicitFlagRequired: input.mode !== "providerless",
    explicitFlagProvided: input.explicitFlagProvided,
    reviewOnly: true,
    readOnly: true,
    mutationForbidden: true,
    autoApplyForbidden: true,
    networkAccess: networkUsed ? "external_cli_invoked" : input.provider === "cli" ? "not_used" : "not_requested",
    networkUsed,
    secretsAccess: "not_requested",
    secretsRequested: false,
    repoAccess: "evidence_packet_only",
    inputBytes: input.inputBytes ?? 0,
    inputTruncated,
    truncationStatus: inputTruncated ? "truncated" : "not_truncated",
    inputArtifacts: unique([
      input.reviewRequestPath,
      input.providerInputJsonPath ?? "",
      input.providerInputMarkdownPath ?? "",
      ...input.evidenceReferences
    ]),
    outputArtifacts: [input.reviewResultPath, input.reviewMarkdownPath]
  };
}

export function buildReviewRequest(input: {
  runId: string;
  acceptedTask: string;
  taskKind: TaskKind;
  plan: TaskRunPlan;
  subtasks: Array<Subtask & { report: string }>;
  checks: CheckResult[];
  gaps: string[];
}): ReviewRequest {
  return {
    runId: input.runId,
    acceptedTask: input.acceptedTask,
    taskKind: input.taskKind,
    plan: input.plan,
    subtaskReports: input.subtasks.map((item) => ({
      id: item.id,
      goal: item.goal,
      reportPath: item.report,
      findings: item.findings,
      status: item.status
    })),
    executorResults: input.subtasks.map((item) => ({
      subtaskId: item.id,
      requestId: item.executor.requestId,
      executor: item.executor.executor,
      status: item.executor.status,
      exitCode: item.executor.exitCode,
      timedOut: item.executor.timedOut
    })),
    commandStatuses: input.subtasks.map((item) => ({
      subtaskId: item.id,
      command: item.evidence.command,
      status: item.evidence.status,
      exitCode: item.evidence.exitCode
    })),
    logPaths: input.subtasks.map((item) => ({
      subtaskId: item.id,
      commandLog: item.executor.artifactPaths.commandLog,
      stdoutLog: item.executor.artifactPaths.stdoutLog,
      stderrLog: item.executor.artifactPaths.stderrLog,
      executorReport: item.evidence.executorReport
    })),
    checks: input.checks.map((item) => ({ command: item.command, result: item.result, exitCode: item.exitCode })),
    gaps: input.gaps
  };
}

export function renderReviewMarkdown(request: ReviewRequest, result: ReviewResult): string {
  const scope =
    result.provider === "providerless"
      ? "This review is read-only and providerless. It reviews task-run evidence artifacts only; it does not execute commands, mutate files, apply patches, push, merge, deploy, or access secrets."
      : "This delegated review is read-only and evidence-packet-only. The provider receives a bounded input package and must not execute commands, mutate files, apply patches, push, merge, deploy, or access secrets.";

  return `# ${request.runId} Review

Reviewer: \`${result.reviewer}\`
Provider: \`${result.provider}\`
Status: \`${result.status}\`
Confidence: \`${result.confidence}\`
Human decision required: ${result.humanDecisionRequired ? "yes" : "no"}

## Scope

${scope}

## Accepted Task

${request.acceptedTask}

## Selected Milestone

${request.plan.recommendedNextMilestone}

## Findings

${result.findings.map((item) => `- ${item.severity}: ${item.message} Evidence: ${item.evidenceReferences.map((ref) => `\`${ref}\``).join(", ") || "n/a"}`).join("\n")}

## Risks

${result.risks.map((item) => `- ${item}`).join("\n")}

## Evidence References

${result.evidenceReferences.map((item) => `- \`${item}\``).join("\n")}

## Recommended Next Action

${result.recommendedNextAction}
`;
}

function referencesForSubtasks(subtaskIds: string[], request: ReviewRequest): string[] {
  const selected = new Set(subtaskIds);
  return request.logPaths
    .filter((item) => selected.has(item.subtaskId))
    .flatMap((item) => [item.commandLog, item.stdoutLog, item.stderrLog, item.executorReport]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
