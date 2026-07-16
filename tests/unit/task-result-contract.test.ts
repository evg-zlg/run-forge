import { describe, expect, it } from "vitest";
import { externalResultContract } from "../../src/product/task-result-contract.js";
import type { ExternalExecutionResult } from "../../src/run/external-execution.js";

describe("normalized external result classification", () => {
  it.each(["failed", "committed-not-pushed", "pushed-no-pr"] as const)("classifies %s publication as a publication failure", (publication) => {
    const result = {
      runId: "PUBLICATION-FAILURE", source: { before: { path: "/repo", head: "abc", status: "" }, after: { path: "/repo", head: "abc", status: "" }, unchanged: true },
      runforgeCapability: "needs owner approval", factoryBaseline: "passed", disposableRepair: "patch-ready", ownerDecisionGate: "approved",
      controlledApply: "applied-to-controlled-worktree", prReadyPackage: "ready", authorityEnvelope: "accepted", patchPath: "patch.diff", controlledWorkspace: null, publication
    } as unknown as ExternalExecutionResult;
    expect(externalResultContract({ taskId: "TASK" }, result, ["npm test"])).toMatchObject({
      status: "failed", ownerGate: { required: false, status: "not_available_failed_publication" },
      nextAction: { recommendation: expect.stringContaining("publication evidence") }, errors: [expect.stringContaining(publication)]
    });
  });
});
