import type { CheckResult } from "./task-run-harness.js";
import type { RepoState } from "./runtime-preparation.js";

export function sourceImmutabilityCheck(external: boolean, before: RepoState | null, after: RepoState | null): CheckResult | null {
  if (!external) return null;
  const unchanged = before !== null && after !== null && before.head === after.head && before.status === after.status;
  return {
    command: "external-source-immutability",
    result: unchanged ? "passed" : "failed",
    exitCode: unchanged ? 0 : 1,
    stdout: unchanged ? "External source HEAD and status are unchanged.\n" : "",
    stderr: unchanged ? "" : `Blocking safety failure: external source mutation detected or source state is unknown. Before=${JSON.stringify(before)} After=${JSON.stringify(after)}\n`
  };
}

export function taskRunCompletionStatus(input: {
  checks: CheckResult[];
  evidencePassed: boolean;
  reviewStatus: string;
}): "completed" | "failed" {
  return input.checks.every((check) => check.result === "passed") && input.evidencePassed && input.reviewStatus !== "provider_unavailable"
    ? "completed"
    : "failed";
}
