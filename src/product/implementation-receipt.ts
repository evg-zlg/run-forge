import type { ImplementationExecutorResult } from "../implementation/executor.js";
import type { TaskSpecV2 } from "./task-spec-v2.js";

export function implementationReceipt(spec: TaskSpecV2, result: ImplementationExecutorResult): Record<string, unknown> {
  const outcome = result.budget.exceeded ? "budget_exhausted" : result.status === "failed_with_diagnostics" ? "implementation_failed" : result.checkpoints.length ? "checkpoint_available" : result.status === "no_change_required" ? "validation_not_started" : "no_progress";
  return {
    outcome,
    failureClassification: result.budget.exceeded ? "budget_exhausted" : result.status === "failed_with_diagnostics" ? "implementation_failed" : result.checkpoints.length ? "deadline_exceeded" : "validation_not_started",
    stopReason: result.budget.exceeded ? "budget_exhausted" : result.checkpoints.length ? "deadline_exceeded" : result.status === "no_change_required" ? "validation_not_started" : "no_progress",
    profile: spec.providerRouting.provider === "openrouter" ? "fast" : "standard",
    classification: spec.discovery.profile === "small-scope" ? "bounded-small" : "standard",
    filesChanged: result.changedFiles,
    patchAvailable: Boolean(result.patchPackage),
    checkpointId: result.checkpoints.at(-1)?.id ?? null,
    testsStarted: result.validationResults.length,
    testsCompleted: result.validationResults.filter((item) => item.outcome === "passed").length,
    calls: result.providerCalls.length,
    inputTokens: result.providerCalls.reduce((sum, call) => sum + (typeof call.inputTokens === "number" ? call.inputTokens : 0), 0),
    outputTokens: result.providerCalls.reduce((sum, call) => sum + (typeof call.outputTokens === "number" ? call.outputTokens : 0), 0),
    reasoningTokens: result.providerCalls.reduce((sum, call) => sum + (typeof call.reasoningTokens === "number" ? call.reasoningTokens : 0), 0),
    costUsd: result.providerCalls.reduce((sum, call) => sum + (typeof call.costUsd === "number" ? call.costUsd : 0), 0),
    queueDurationMs: 0,
    providerDurationMs: 0,
    totalDurationMs: 0,
  };
}
