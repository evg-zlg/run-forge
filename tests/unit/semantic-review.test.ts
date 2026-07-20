import { describe, expect, it, vi } from "vitest";
import { buildNormalizedHandoffPackage } from "../../src/product/task-result-contract.js";
import { runSemanticReview, semanticReviewBudgetOverrun, semanticReviewPhaseTimeoutMs } from "../../src/implementation/semantic-review.js";

const base = {
  task: "Fix calculation semantics", goal: "Correct behavior", acceptanceCriteria: ["Handles negative operands"],
  changedFiles: ["src/calculate.ts"], patch: "diff --git a/src/calculate.ts b/src/calculate.ts", structuralEvidence: ["validation/test.json"],
  taskSpecContext: { taskId: "SEMANTIC-1", validation: { commands: ["pnpm test"] } },
  validationOutcomes: [{ command: "pnpm test", outcome: "passed", exitCode: 0, stdout: "42 tests passed", artifactPaths: ["validation/test.json"] }],
  knownLimitations: ["UI validation was not requested."],
  independentReview: { executionAgreementId: "ea_v1_test", responsibleParty: "runforge" as const },
  validatedCheckpoint: { id: "implementation-0", digest: "abc123", path: "checkpoints/implementation-0" },
  reviewBudget: { tokenLimit: 14_000, timeoutMs: 21_000, deadlineAt: "2026-07-20T12:00:00.000Z" },
  selectedReviewer: { provider: "local-coding-agent", model: "review-model" },
};

describe("semantic review adapter", () => {
  it("uses a distinct provider invocation and keeps semantic evidence separate from structural evidence", async () => {
    const invoke = vi.fn(async (prompt: string) => ({
      provider: "local-coding-agent", model: "review-model", invocationId: "semantic-review-0",
      stdout: JSON.stringify({ semanticReview: { confidence: "high", limitations: ["No browser validation was available."], findings: [] } }), stderr: "", evidence: ["provider/semantic-review.stdout.log"],
    }));
    const review = await runSemanticReview({ ...base, allowed: true, invoke });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toContain("Structural validation evidence is context only and cannot satisfy semantic review");
    expect(invoke.mock.calls[0]![0]).toContain('"outcome": "passed"');
    expect(invoke.mock.calls[0]![0]).toContain('"responsibleParty": "runforge"');
    expect(invoke.mock.calls[0]![0]).toContain('"id": "implementation-0"');
    expect(invoke.mock.calls[0]![0]).toContain("UI validation was not requested.");
    expect(review).toMatchObject({ kind: "semantic", status: "completed", performed: true, selectedReviewer: { provider: "local-coding-agent", model: "review-model" }, reviewer: { invocationId: "semantic-review-0" }, confidence: "high", limitations: ["No browser validation was available."], findings: [] });
    expect(review.evidence).toEqual(["provider/semantic-review.stdout.log"]);
    expect(review.evidence).not.toContain("validation/test.json");
  });

  it("normalizes every required finding field and preserves it in the portable handoff", async () => {
    const finding = { severity: "high", file: "src/calculate.ts", location: "12:3-12:18", category: "correctness", evidence: "Negative input reaches the positive-only branch.", recommendation: "Handle negative input before the positive-only branch and add a regression test.", blocking: true } as const;
    const review = await runSemanticReview({ ...base, allowed: true, invoke: async () => ({ provider: "agent", model: "reviewer", invocationId: "review-1", stdout: JSON.stringify({ semanticReview: { confidence: "medium", limitations: ["Only the supplied patch was reviewed."], findings: [finding] } }), stderr: "", evidence: ["review.json"] }) });
    const handoff = buildNormalizedHandoffPackage({ profile: "assist-only", summary: "Implementation validated; owner review required.", patch: "implementation.patch", branch: null, commit: null, findings: review.findings, structuralEvidence: [{ kind: "command", reference: "validation/test.json", summary: "Structural tests passed." }], semanticReview: review, nextActions: [{ party: "owner", exactAction: "Resolve the blocking semantic finding." }], targetSha: "abc", baseSha: "def" });
    expect(handoff.findings).toEqual([finding]);
    expect(handoff.structuralEvidence[0]).toMatchObject({ kind: "command", reference: "validation/test.json" });
    expect(handoff.semanticReview).toMatchObject({ kind: "semantic", status: "completed", performed: true, confidence: "medium", limitations: ["Only the supplied patch was reviewed."], findings: [finding] });
  });

  it("truthfully delegates unavailable and forbidden review without fabricating findings", async () => {
    const unavailable = await runSemanticReview({ ...base, allowed: true });
    const forbidden = await runSemanticReview({ ...base, allowed: false, delegatedParty: "owner", invoke: vi.fn() });
    expect(unavailable).toMatchObject({ status: "unavailable", performed: false, selectedReviewer: { provider: "local-coding-agent", model: "review-model" }, confidence: "unknown", findings: [], delegation: { party: "external_session" } });
    expect(forbidden).toMatchObject({ status: "forbidden", performed: false, findings: [], delegation: { party: "owner" } });
  });

  it("derives a dedicated review deadline that is smaller than the whole task timeout", () => {
    expect(semanticReviewPhaseTimeoutMs(300_000, 14_000, 180_000)).toBeLessThan(300_000);
    expect(semanticReviewPhaseTimeoutMs(300_000, 14_000, 180_000)).toBeGreaterThanOrEqual(250);
    expect(semanticReviewBudgetOverrun([{ purpose: "semantic-review", tokenUsage: 14_001 }], 14_000, 180_000)).toEqual({ actual: 14_001, limit: 14_000 });
  });
});
