import type { ImplementationExecutorResult } from "../implementation/executor.js";
import type { TaskSpecV2 } from "./task-spec-v2.js";

export function implementationReceipt(spec: TaskSpecV2, result: ImplementationExecutorResult): Record<string, unknown> {
  // Semantic review is an independently accounted optional phase. Its evidence remains
  // in providerCalls/usage, but it must not rewrite the implementation receipt.
  const implementationCalls = result.providerCalls.filter((call) => call.purpose !== "semantic-review" && call.phase !== "reviewer");
  const latest = implementationCalls.at(-1);
  const validationFailure = result.validationResults.find((item) => item.outcome !== "passed");
  const noProgress = latest?.noProgress === true;
  const timedOut = latest?.timedOut === true;
  const providerFailed = result.status === "failed_with_diagnostics" && !noProgress && !timedOut && !validationFailure;
  const failureClassification = result.budget.exceeded ? "budget_exhausted"
    : noProgress ? "no_progress"
      : timedOut ? (result.checkpoints.length ? "deadline_exceeded" : "validation_not_started")
        : validationFailure?.classification === "infrastructure" || validationFailure?.infrastructureDefect ? "infrastructure_failure"
          : validationFailure ? "implementation_failed"
            : providerFailed ? "provider_failed"
              : null;
  const outcome = result.budget.exceeded ? "budget_exhausted"
    : noProgress ? "no_progress"
      : timedOut ? (result.checkpoints.length ? "checkpoint_available" : "deadline_exceeded")
        : validationFailure?.classification === "infrastructure" || validationFailure?.infrastructureDefect ? "infrastructure_failure"
          : validationFailure ? "implementation_failed"
            : providerFailed ? "provider_failed"
              : "completed";
  return {
    outcome,
    failureClassification,
    stopReason: failureClassification ?? "completed",
    filesChanged: result.changedFiles,
    patchAvailable: result.changedFiles.length > 0,
    checkpointId: result.checkpoints.at(-1)?.id ?? null,
    testsStarted: result.validationResults.length,
    testsCompleted: result.validationResults.length,
    calls: implementationCalls.length,
    inputTokens: implementationCalls.reduce((sum, call) => sum + (typeof call.inputTokens === "number" ? call.inputTokens : 0), 0),
    outputTokens: implementationCalls.reduce((sum, call) => sum + (typeof call.outputTokens === "number" ? call.outputTokens : 0), 0),
    reasoningTokens: implementationCalls.reduce((sum, call) => sum + (typeof call.reasoningTokens === "number" ? call.reasoningTokens : 0), 0),
    // v1 portable receipt fields.
    queueDuration: 0, providerExecutionDuration: 0, totalDuration: 0,
    provider: String(implementationCalls[0]?.provider ?? "local"), model: implementationCalls[0]?.model ?? null,
    phase: "implementation", cachedTokens: 0,
    billedTokens: implementationCalls.reduce((sum, call) => sum + (typeof call.tokenUsage === "number" ? call.tokenUsage : 0), 0),
    availability: { queueDuration: "derived", inputTokens: "reported", cachedTokens: "derived", outputTokens: "reported", reasoningTokens: "reported", billedTokens: "reported", cost: "reported" },
    filesRead: implementationCalls.flatMap((call) => Array.isArray((call.progressSignals as any)?.filesInspected) ? (call.progressSignals as any).filesInspected : []),
    lastCompletedStage: outcome === "completed" ? "completed" : result.checkpoints.length ? "checkpoint" : "provider",
    nextSafeAction: outcome === "completed" ? "review_result" : noProgress ? "retry_with_reduced_context" : timedOut ? "retry_with_bounded_deadline" : validationFailure?.classification === "infrastructure" || validationFailure?.infrastructureDefect ? "repair_infrastructure_then_retry" : "inspect_diagnostics_then_retry",
    cost: implementationCalls.reduce((sum, call) => sum + (typeof call.costUsd === "number" ? call.costUsd : 0), 0),
  };
}
