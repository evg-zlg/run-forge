import { describe, expect, it } from "vitest";
import { normalizedSemanticReview } from "../../src/control-plane/manager-results.js";

const finding = { severity: "high", file: "src/value.ts", location: "12:3", category: "correctness", evidence: "The branch returns a stale value.", recommendation: "Update the branch and add a regression test.", blocking: true };
const completed = (overrides: Record<string, unknown> = {}) => ({
  review: { semantic: { status: "completed", performed: true, reviewer: { provider: "openrouter", model: "review/test", invocationId: "review-1" }, findings: [finding], limitations: [], ...overrides } },
  providerCalls: [{ purpose: "semantic-review", phase: "reviewer", provider: "openrouter", model: "review/test", providerCalls: true, networkAuthorized: true, success: true, invocationId: "review-1", exitCode: 0 }],
});

describe("normalized semantic review projection", () => {
  it("reports completion only for a matching successful provider-backed review", () => {
    expect(normalizedSemanticReview(completed())).toEqual({ performed: true, reviewer: { provider: "openrouter", model: "review/test", invocationId: "review-1" }, providerCalls: 1, findings: [finding], limitations: [], outcome: "semantic_review_completed" });
  });

  it.each([
    ["providerless", completed({ reviewer: { provider: null, model: null, invocationId: null } })],
    ["unmatched invocation", withCall({ invocationId: "other" })],
    ["failed invocation", withCall({ exitCode: 1 })],
    ["mismatched provider", withCall({ provider: "configured-local-credential" })],
    ["mismatched model", withCall({ model: "review/other" })],
    ["provider-call marker false", withCall({ providerCalls: false })],
    ["network authorization false", withCall({ networkAuthorized: false })],
    ["success marker false", withCall({ success: false })],
    ["malformed finding", completed({ findings: [{ ...finding, evidence: "" }] })],
    ["unknown severity", completed({ findings: [{ ...finding, severity: "urgent" }] })],
  ])("fails closed for %s", (_name, result) => {
    expect(normalizedSemanticReview(result)).toMatchObject({ performed: false, findings: [], outcome: "reviewer_unavailable", limitations: [expect.any(String)] });
  });

  it("does not count a structurally tagged reviewer entry without the provider-call marker", () => {
    expect(normalizedSemanticReview(withCall({ providerCalls: false }))).toMatchObject({ performed: false, providerCalls: 0 });
  });
});

function withCall(overrides: Record<string, unknown>): Record<string, unknown> {
  const result = completed();
  const call = (result.providerCalls as Array<Record<string, unknown>>)[0]!;
  return { ...result, providerCalls: [{ ...call, ...overrides }] };
}
