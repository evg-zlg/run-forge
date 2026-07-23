import { describe, expect, it } from "vitest";
import { phaseTokenOverrun, routingBudgetOverrun } from "../../src/implementation/executor-accounting.js";

const routing = { tokenBudget: { total: 100, perPhase: { planner: 50 } }, costBudgetUsd: 0.1 };

describe("OpenRouter budget accounting", () => {
  it("stops closed when token accounting is absent", () => {
    expect(routingBudgetOverrun([{ phase: "planner", tokenUsage: null, costUsd: 0.01 }], routing, "planner")).toMatchObject({ kind: "accounting_unavailable", reason: expect.stringContaining("token accounting is incomplete") });
  });

  it("stops closed when a configured cost budget cannot be accounted", () => {
    expect(routingBudgetOverrun([{ phase: "planner", tokenUsage: 10, costUsd: null }], routing, "planner")).toMatchObject({ kind: "accounting_unavailable", reason: expect.stringContaining("cost accounting is incomplete") });
  });
});

describe("phase budget accounting", () => {
  it("uses cumulative repair usage rather than only the final repair call", () => {
    expect(phaseTokenOverrun([
      { phase: "repair", tokenUsage: 10_911 },
      { phase: "repair", tokenUsage: 10_912 },
      { phase: "implementer", tokenUsage: 50_000 },
    ], "repair", 12_094)).toEqual({ actual: 21_823, limit: 12_094 });
  });
});
