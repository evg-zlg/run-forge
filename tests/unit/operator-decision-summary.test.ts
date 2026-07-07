import { describe, expect, it } from "vitest";
import { validateOperatorDecisionObject } from "../../src/run/operator-decision-summary.js";

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalPacket: "/tmp/runforge/packet",
    proposalPatch: "/tmp/runforge/packet/proposal.patch",
    decision: "accepted",
    finalOutcome: "accepted",
    reason: "validation_passed_after_operator_apply",
    validation: { passed: true, status: "passed", packet: "/tmp/runforge/validation/packet" },
    apply: {
      mode: "operator_simulated_manual_apply",
      appliedTo: "disposable_copy",
      originalRepoMutated: false
    },
    runforgeAppliedPatch: false,
    safety: {
      providerUsed: false,
      networkUsed: false,
      dbUsed: false,
      deployUsed: false,
      pushUsed: false,
      mergeUsed: false
    },
    ...overrides
  };
}

describe("operator decision safety lint", () => {
  it("accepts a safe accepted operator decision", () => {
    expect(validateOperatorDecisionObject(validRecord())).toEqual([]);
  });

  it("rejects accepted decisions that mutate original repos or lack passing after-validation", () => {
    expect(validateOperatorDecisionObject(validRecord({
      validation: { passed: false, status: "failed" },
      apply: { mode: "operator_simulated_manual_apply", appliedTo: "disposable_copy", originalRepoMutated: true }
    }))).toEqual(expect.arrayContaining([
      "operator-decision.json accepted decision cannot have originalRepoMutated=true",
      "operator-decision.json accepted decision requires passed after-validation"
    ]));

    expect(validateOperatorDecisionObject(validRecord({ validation: {} }))).toContain("operator-decision.json accepted decision missing after-validation result");
  });

  it("rejects missing manual boundary and safety fields", () => {
    const errors = validateOperatorDecisionObject(validRecord({
      proposalPacket: "",
      proposalPatch: "",
      runforgeAppliedPatch: true,
      apply: { mode: "operator_simulated_manual_apply", appliedTo: "original_repo", originalRepoMutated: false },
      safety: undefined
    }));

    expect(errors).toEqual(expect.arrayContaining([
      "operator-decision.json missing proposalPacket link",
      "operator-decision.json missing proposalPatch link",
      "operator-decision.json missing runforgeAppliedPatch=false",
      "operator-decision.json apply.appliedTo must not be original_repo",
      "operator-decision.json missing safety summary"
    ]));
  });

  it("treats rejected decisions as valid workflow evidence when reason and safety are present", () => {
    expect(validateOperatorDecisionObject(validRecord({
      decision: "rejected",
      finalOutcome: "rejected",
      reason: "operator_declined",
      validation: { passed: false, status: "failed", packet: "/tmp/runforge/validation/packet" },
      apply: { mode: "operator_declined", appliedTo: "disposable_copy", originalRepoMutated: false }
    }))).toEqual([]);

    expect(validateOperatorDecisionObject(validRecord({
      decision: "rejected",
      finalOutcome: "rejected",
      reason: ""
    }))).toContain("operator-decision.json rejected decision requires reason");
  });
});
