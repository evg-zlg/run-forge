import { describe, expect, it } from "vitest";
import type { ImplementationExecutorResult } from "../../src/implementation/executor.js";
import { phaseUsage } from "../../src/product/task-spec-implementation-result.js";
import type { TaskSpecV2 } from "../../src/product/task-spec-v2.js";

const spec = {
  execution: { budgetMode: "strict", phaseBudgets: { implementation: 100, repair: 80, review: 60 } },
  providerRouting: { tokenBudget: { perPhase: { planner: 40, implementer: 100, repair: 80, reviewer: 60, logCompression: 20 } } },
} as unknown as TaskSpecV2;

function result(providerCalls: Array<Record<string, unknown>>): ImplementationExecutorResult {
  return { providerCalls, budget: { overrunPhase: null, accounting: "provider" } } as ImplementationExecutorResult;
}

describe("normalized implementation usage", () => {
  it("aggregates multiple reported provider costs and tokens by their actual phase", () => {
    const usage = phaseUsage(spec, result([
      { phase: "planner", tokenUsage: 10, costUsd: 0.01, usageAccounting: "provider" },
      { phase: "implementer", tokenUsage: 20, costUsd: 0.02, usageAccounting: "provider", iteration: 0 },
      { phase: "logCompression", tokenUsage: 5, costUsd: 0.005, usageAccounting: "provider" },
    ]));

    expect(usage).toMatchObject({
      providerCalls: 3,
      totalTokens: 35,
      tokenAvailability: "complete",
      costUsd: 0.035,
      costAvailability: "complete",
      phases: {
        analysis: { actualTokens: 10, costUsd: 0.01, tokenAvailability: "complete", costAvailability: "complete" },
        implementation: { actualTokens: 20, costUsd: 0.02 },
        logCompression: { actualTokens: 5, costUsd: 0.005 },
      },
    });
  });

  it("keeps known totals but labels partial and unavailable accounting honestly", () => {
    const partial = phaseUsage(spec, result([
      { phase: "implementer", tokenUsage: 20, costUsd: 0.02, usageAccounting: "provider", iteration: 0 },
      { phase: "reviewer", tokenUsage: null, costUsd: null, usageAccounting: "provider" },
    ]));
    const unavailable = phaseUsage(spec, result([
      { phase: "implementer", tokenUsage: null, costUsd: null, usageAccounting: "unavailable", iteration: 0 },
    ]));

    expect(partial).toMatchObject({ totalTokens: 20, tokenAvailability: "partial", costUsd: 0.02, costAvailability: "partial" });
    expect(unavailable).toMatchObject({ totalTokens: null, tokenAvailability: "unavailable", costUsd: null, costAvailability: "unavailable" });
  });

  it("reports provider repair overrun from durable phase usage even if the executor summary missed it", () => {
    const usage = phaseUsage({ ...spec, execution: { ...spec.execution, phaseBudgets: { ...spec.execution.phaseBudgets, repair: 12_094 } } }, result([
      { phase: "repair", tokenUsage: 10_911, usageAccounting: "provider", iteration: 1 },
      { phase: "repair", tokenUsage: 10_912, usageAccounting: "provider", iteration: 2 },
      { phase: "validation", tokenUsage: 999_999, usageAccounting: "synthetic" },
    ]));

    expect(usage).toMatchObject({
      totalTokens: 21_823,
      phases: { repair: { actualTokens: 21_823, requestedLimit: 12_094, effectiveLimit: 12_094, exceeded: true } },
      syntheticAccounting: { totalTokens: 999_999, phases: { validation: { actualTokens: 999_999, exceeded: false } } },
    });
  });
});
