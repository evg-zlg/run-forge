import type { FailureTriageCategory, FailureTriageConfidence } from "./external-failure-triage-types.js";

export type ProposalReadinessOutcome =
  | "ready_for_code_proposal"
  | "needs_more_context"
  | "research_only"
  | "blocked_by_safety"
  | "no_failure_observed";

export interface ReadinessDecision {
  readinessOutcome: ProposalReadinessOutcome;
  canAttemptCodeProposal: boolean;
  failureCategory: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  missingContext: string[];
  recommendedNextAction: string;
}

export interface ReadinessRootCause {
  category?: FailureTriageCategory;
  confidence?: FailureTriageConfidence;
  safeNextAction?: string;
  sourceCheckStatus?: string;
}

export interface ReadinessTriageRun {
  status?: string;
  sourceCheckStatus?: string;
  category?: FailureTriageCategory;
  confidence?: FailureTriageConfidence;
}

export interface ReadinessSafetyReport {
  blockedCommands?: Array<{ reason?: string }>;
  originalRepoMutationVerdict?: string;
  noPushAttempted?: boolean;
  noMergeAttempted?: boolean;
  noDeployAttempted?: boolean;
  noApplyToOriginalRepoAttempted?: boolean;
}

export function decideReadiness(rootCause: ReadinessRootCause, triageRun: ReadinessTriageRun | null, safety: ReadinessSafetyReport | null): ReadinessDecision {
  const failureCategory = rootCause.category ?? triageRun?.category ?? "unknown_failure";
  const confidence = rootCause.confidence ?? triageRun?.confidence ?? "low";
  if (hasSafetyBlocker(safety)) {
    return decision("blocked_by_safety", false, failureCategory, confidence, ["Safety report indicates a blocked command or original repository mutation risk."], "Resolve the safety blocker before attempting any code proposal.");
  }
  if (failureCategory === "no_failure_observed" || triageRun?.status === "no_failure_observed") {
    return decision("no_failure_observed", false, "no_failure_observed", "high", [], "No code proposal is needed because the source packet did not observe a failure.");
  }
  if (failureCategory === "timeout") {
    return decision("research_only", false, failureCategory, confidence, ["The timeout evidence does not identify a deterministic source edit."], "Research the timeout with narrower commands or larger timeout limits before proposing code.");
  }
  if (isDiagnosticSetupStatus(rootCause.sourceCheckStatus ?? triageRun?.sourceCheckStatus ?? triageRun?.status)) {
    return decision("needs_more_context", false, failureCategory, confidence, ["Setup/preflight failed and main commands ran only in diagnostic mode, so this is not clean verification evidence."], "Fix setup/preflight first, then rerun a clean external check before attempting a code proposal.");
  }
  if (failureCategory === "dependency_missing" || failureCategory === "environment_error" || failureCategory === "configuration_error" || failureCategory === "command_not_found") {
    return decision("needs_more_context", false, failureCategory, confidence, [`${failureCategory} requires dependency, tool, or environment setup before source edits are safe to consider.`], setupRecommendedNextAction(rootCause.safeNextAction));
  }
  if (failureCategory === "test_assertion_failure" || failureCategory === "typecheck_error" || failureCategory === "lint_error" || failureCategory === "build_error") {
    return decision("ready_for_code_proposal", true, failureCategory, confidence === "low" ? "medium" : confidence, [], "Create a proposal patch in a disposable workspace and verify it there; human review remains required.");
  }
  return decision("needs_more_context", false, failureCategory, confidence, [`${failureCategory} is not deterministic enough for the current proposal engine.`], rootCause.safeNextAction ?? "Collect more focused failure evidence before attempting a code proposal.");
}

function decision(
  readinessOutcome: ProposalReadinessOutcome,
  canAttemptCodeProposal: boolean,
  failureCategory: FailureTriageCategory,
  confidence: FailureTriageConfidence,
  missingContext: string[],
  recommendedNextAction: string
): ReadinessDecision {
  return { readinessOutcome, canAttemptCodeProposal, failureCategory, confidence, missingContext, recommendedNextAction };
}

function setupRecommendedNextAction(fallback?: string): string {
  return fallback ?? "Install or prepare dependencies in the disposable workspace, or provide an explicit setup command, then rerun the failing command before attempting a code proposal.";
}

function isDiagnosticSetupStatus(status?: string): boolean {
  return status === "setup_failed_main_passed" || status === "setup_failed_main_failed";
}

function hasSafetyBlocker(safety: ReadinessSafetyReport | null): boolean {
  if (!safety) return false;
  if ((safety.blockedCommands?.length ?? 0) > 0) return true;
  if (safety.originalRepoMutationVerdict === "changed") return true;
  return safety.noPushAttempted === false || safety.noMergeAttempted === false || safety.noDeployAttempted === false || safety.noApplyToOriginalRepoAttempted === false;
}
