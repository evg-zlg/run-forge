import { writeFile } from "node:fs/promises";
import type { Subtask } from "./task-run-harness.js";
import type { TaskKind } from "./task-run-planner.js";
import type { ReviewRequest } from "./task-run-reviewer.js";

export type ProviderInputPackage = {
  task: string;
  planSummary: {
    kind: TaskKind;
    basis: string[];
    subtaskCount: number;
    recommendedNextMilestone: string;
  };
  subtaskStatuses: Array<{
    id: string;
    goal: string;
    status: Subtask["status"];
    commandStatus: Subtask["evidence"]["status"];
    exitCode: number | null;
  }>;
  selectedFindings: Array<{
    subtaskId: string;
    findingCount: number;
    evidenceRef: string;
  }>;
  /** Provider input never carries raw command or provider output. */
  rawLogState: "none";
  logDigestRefs: string[];
  evidencePaths: string[];
  knownGaps: string[];
  limits: {
    rawLogBytesIncluded: 0;
    rawLogArtifactsExcluded: number;
  };
};

export async function writeProviderInputPackage(input: {
  request: ReviewRequest;
  repoRoot: string;
  jsonPath: string;
  markdownPath: string;
}): Promise<{ package: ProviderInputPackage; inputBytes: number; inputTruncated: boolean }> {
  const providerInput = await buildProviderInputPackage(input.request, input.repoRoot);
  const json = JSON.stringify(providerInput, null, 2) + "\n";
  const markdown = renderProviderInputMarkdown(providerInput);
  await writeFile(input.jsonPath, json, "utf8");
  await writeFile(input.markdownPath, markdown, "utf8");
  return {
    package: providerInput,
    inputBytes: Buffer.byteLength(json, "utf8") + Buffer.byteLength(markdown, "utf8"),
    inputTruncated: false
  };
}

async function buildProviderInputPackage(request: ReviewRequest, repoRoot: string): Promise<ProviderInputPackage> {
  // `repoRoot` remains in the API for stable callers. Never read a log here:
  // this package can be sent to a provider, and refs must cross that boundary
  // through a dedicated digest stage rather than bounded raw excerpts.
  void repoRoot;
  const rawLogArtifactsExcluded = request.logPaths.reduce((total) => total + 4, 0);

  return {
    task: request.acceptedTask,
    planSummary: {
      kind: request.taskKind,
      basis: request.plan.planningBasis.slice(0, 6),
      subtaskCount: request.plan.subtasks.length,
      recommendedNextMilestone: request.plan.recommendedNextMilestone
    },
    subtaskStatuses: request.subtaskReports.map((report) => {
      const command = request.commandStatuses.find((item) => item.subtaskId === report.id);
      return {
        id: report.id,
        goal: report.goal,
        status: report.status,
        commandStatus: command?.status ?? "failed",
        exitCode: command?.exitCode ?? null
      };
    }),
    selectedFindings: request.subtaskReports.map((report) => ({
      subtaskId: report.id,
      findingCount: report.findings.length,
      evidenceRef: report.reportPath
    })),
    rawLogState: "none",
    logDigestRefs: [],
    evidencePaths: unique([
      ...request.subtaskReports.map((item) => item.reportPath),
      ...request.logPaths.flatMap((item) => [item.commandLog, item.stdoutLog, item.stderrLog, item.executorReport])
    ]),
    knownGaps: request.gaps,
    limits: {
      rawLogBytesIncluded: 0,
      rawLogArtifactsExcluded
    }
  };
}

function renderProviderInputMarkdown(input: ProviderInputPackage): string {
  return `# Provider Review Input

## Task

${input.task}

## Plan Summary

- Kind: \`${input.planSummary.kind}\`
- Subtasks: ${input.planSummary.subtaskCount}
- Recommended next milestone: ${input.planSummary.recommendedNextMilestone}

## Subtask Statuses

${input.subtaskStatuses.map((item) => `- \`${item.id}\`: ${item.commandStatus}; exit ${item.exitCode}; ${item.goal}`).join("\n")}

## Selected Findings

${input.selectedFindings.map((item) => `- \`${item.subtaskId}\`: ${item.findingCount} finding(s); evidence: \`${item.evidenceRef}\``).join("\n")}

## Raw Log Boundary

Raw command/provider logs are excluded from provider input. Raw-log state: \`${input.rawLogState}\`.

${input.logDigestRefs.length ? input.logDigestRefs.map((item) => `- \`${item}\``).join("\n") : "- no digest references supplied"}

## Evidence Paths

${input.evidencePaths.map((item) => `- \`${item}\``).join("\n")}

## Known Gaps

${input.knownGaps.map((item) => `- ${item}`).join("\n")}

## Limits

- Raw log bytes included: ${input.limits.rawLogBytesIncluded}
- Raw log artifacts excluded: ${input.limits.rawLogArtifactsExcluded}
`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
