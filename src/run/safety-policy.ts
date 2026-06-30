import type { RunSpec, SafetyReport } from "../core/types.js";

export interface RunSafetyPolicy {
  profile: RunSpec["safetyProfile"];
  applyMode: NonNullable<RunSpec["applyMode"]>;
  repoWritesAllowed: boolean;
  commandExecutionAllowed: boolean;
  autoPushAllowed: false;
  autoMergeAllowed: false;
  humanDecisionRequired: boolean;
  blockedReasons: string[];
  report: SafetyReport;
}

export function buildRunSafetyPolicy(spec: RunSpec, report: SafetyReport): RunSafetyPolicy {
  const applyMode = spec.applyMode ?? defaultApplyMode(spec.taskType);
  const blockedReasons: string[] = [];
  if (report.secretScan.status === "failed") blockedReasons.push("Secret-like values were detected in run inputs.");
  if (spec.taskType === "command-check" && spec.safetyProfile !== "trusted-local") {
    blockedReasons.push("command-check requires trusted-local safetyProfile.");
  }
  if (spec.taskType === "code-proposal" && applyMode === "isolated-worktree") {
    blockedReasons.push("isolated-worktree applyMode is declared but not implemented in local rails MVP.");
  }
  return {
    profile: spec.safetyProfile,
    applyMode,
    repoWritesAllowed: false,
    commandExecutionAllowed: spec.taskType === "command-check" && spec.safetyProfile === "trusted-local",
    autoPushAllowed: false,
    autoMergeAllowed: false,
    humanDecisionRequired: spec.taskType === "code-proposal",
    blockedReasons,
    report
  };
}

function defaultApplyMode(taskType: RunSpec["taskType"]): NonNullable<RunSpec["applyMode"]> {
  return taskType === "code-proposal" ? "patch-artifact" : "none";
}
