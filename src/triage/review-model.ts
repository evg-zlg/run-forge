import type { FailureClassification, RepoInspection, ReviewModel } from "../core/types.js";
import { extractLogExcerpts } from "./log-parser.js";
import { chooseSafeNextCommand } from "./next-command.js";

export function buildReview(input: {
  logText: string;
  classification: FailureClassification;
  repo: RepoInspection;
}): ReviewModel {
  const safeNextCommand = chooseSafeNextCommand(input.classification.category, input.repo);
  return {
    category: input.classification.category,
    rootCause: rootCause(input.classification),
    confidence: input.classification.confidence,
    humanDecisionNeeded: input.classification.confidence !== "high",
    summary: [
      `RunForge classified the failure as ${input.classification.category}.`,
      "This report is generated from the provided log and read-only repository inspection.",
      "No commands were executed during triage."
    ],
    logExcerpts: extractLogExcerpts(input.logText),
    relevantFiles: [...input.repo.filesMentionedInLog, ...input.repo.guidanceFiles],
    relevantCommands: Object.entries(input.repo.scripts).map(([name, command]) => `${name}: ${command}`),
    checked: ["Input log", "package.json scripts when present", "lockfile type", "files directly mentioned by the log"],
    notChecked: ["No package scripts were executed", "No network access was used", "No repository files were modified"],
    safeNextCommand,
    whyCommandIsSafe: safeNextCommand
      ? "The command is a suggested diagnostic command and was not executed by RunForge."
      : "RunForge could not determine a specific read-only diagnostic command from the available scripts.",
    risks: ["The root cause may be incomplete if the log omits earlier failures.", "Heuristic triage can miss project-specific conventions."],
    followUp: ["Run the safe next command locally if you want to confirm the diagnosis.", "Inspect the listed files before making changes."]
  };
}

function rootCause(classification: FailureClassification): string {
  const signal = classification.signals[0] ? ` based on signal "${classification.signals[0]}"` : "";
  switch (classification.category) {
    case "typecheck_failure":
      return `Likely TypeScript typecheck failure${signal}.`;
    case "test_failure":
      return `Likely failing test assertion or test runner failure${signal}.`;
    case "env_config_failure":
      return `Likely missing configuration, environment variable, or required file${signal}.`;
    case "dependency_failure":
      return `Likely package manager or dependency resolution failure${signal}.`;
    case "build_failure":
      return `Likely build pipeline failure${signal}.`;
    case "infra_timeout_failure":
      return `Likely infrastructure, network, rate limit, or timeout failure${signal}.`;
    default:
      return "Unknown root cause; the log did not contain a supported failure signal.";
  }
}
