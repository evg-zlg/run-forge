import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    findings: string[];
  }>;
  boundedLogExcerpts: Array<{
    subtaskId: string;
    path: string;
    excerpt: string;
    bytesRead: number;
    truncated: boolean;
  }>;
  evidencePaths: string[];
  knownGaps: string[];
  limits: {
    maxLogBytesPerArtifact: number;
    maxTotalLogBytes: number;
    totalLogBytes: number;
    truncated: boolean;
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
    inputTruncated: providerInput.limits.truncated
  };
}

async function buildProviderInputPackage(request: ReviewRequest, repoRoot: string): Promise<ProviderInputPackage> {
  const maxLogBytesPerArtifact = 4000;
  const maxTotalLogBytes = 16_000;
  let totalLogBytes = 0;
  let truncated = false;
  const logCandidates = request.logPaths.flatMap((item) => [
    { subtaskId: item.subtaskId, path: item.commandLog },
    { subtaskId: item.subtaskId, path: item.stdoutLog },
    { subtaskId: item.subtaskId, path: item.stderrLog },
    { subtaskId: item.subtaskId, path: item.executorReport }
  ]);
  const boundedLogExcerpts: ProviderInputPackage["boundedLogExcerpts"] = [];
  for (const item of logCandidates) {
    if (totalLogBytes >= maxTotalLogBytes) {
      truncated = true;
      break;
    }
    const remaining = maxTotalLogBytes - totalLogBytes;
    const limit = Math.min(maxLogBytesPerArtifact, remaining);
    const excerpt = await readBounded(resolve(repoRoot, item.path), limit);
    totalLogBytes += excerpt.bytesRead;
    truncated = truncated || excerpt.truncated;
    boundedLogExcerpts.push({ subtaskId: item.subtaskId, path: item.path, ...excerpt });
  }

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
      findings: report.findings.slice(0, 4)
    })),
    boundedLogExcerpts,
    evidencePaths: unique([
      ...request.subtaskReports.map((item) => item.reportPath),
      ...request.logPaths.flatMap((item) => [item.commandLog, item.stdoutLog, item.stderrLog, item.executorReport])
    ]),
    knownGaps: request.gaps,
    limits: {
      maxLogBytesPerArtifact,
      maxTotalLogBytes,
      totalLogBytes,
      truncated
    }
  };
}

async function readBounded(path: string, maxBytes: number): Promise<{ excerpt: string; bytesRead: number; truncated: boolean }> {
  try {
    const text = await readFile(path, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= maxBytes) return { excerpt: text, bytesRead: bytes, truncated: false };
    const excerpt = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
    return { excerpt, bytesRead: maxBytes, truncated: true };
  } catch (error) {
    const excerpt = `Unable to read artifact: ${error instanceof Error ? error.message : String(error)}`;
    return { excerpt, bytesRead: Buffer.byteLength(excerpt, "utf8"), truncated: false };
  }
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

${input.selectedFindings.map((item) => `- \`${item.subtaskId}\`: ${item.findings.join(" ")}`).join("\n")}

## Bounded Log Excerpts

${input.boundedLogExcerpts.map((item) => `### ${item.path}\n\n\`\`\`text\n${item.excerpt}\n\`\`\`\n`).join("\n")}

## Evidence Paths

${input.evidencePaths.map((item) => `- \`${item}\``).join("\n")}

## Known Gaps

${input.knownGaps.map((item) => `- ${item}`).join("\n")}

## Limits

- Max bytes per artifact: ${input.limits.maxLogBytesPerArtifact}
- Max total log bytes: ${input.limits.maxTotalLogBytes}
- Total log bytes included: ${input.limits.totalLogBytes}
- Truncated: ${input.limits.truncated ? "yes" : "no"}
`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
