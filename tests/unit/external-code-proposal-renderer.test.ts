import { describe, expect, it } from "vitest";
import { renderHumanReview, renderPatchSummary } from "../../src/run/external-code-proposal-renderer.js";

const baseOverview = {
  strategy: "provider_cli",
  reviewerDecision: "rejected_no_safe_proposal",
  reviewerReason: "No proposal patch was generated for this packet.",
  filesChanged: [],
  verificationCommands: ["pnpm test"],
  originalRepoMutationVerdict: "unchanged",
  diagnostics: [] as string[]
};

describe("external code proposal renderer", () => {
  it("provider_rejected summary cannot imply the patch was accepted", () => {
    const text = renderHumanReview("provider_rejected", {
      ...baseOverview,
      diagnostics: ["patch touches forbidden path: .env"]
    });
    expect(text).toContain("Operator verdict: do_not_apply");
    expect(text).toContain("Failure class: forbidden_path");
    expect(text).toContain("Do not apply proposal.patch from this packet.");
    expect(text).not.toContain("accepted_for_human_review");
  });

  it("verification_failed summary cannot imply the patch is safe", () => {
    const text = renderHumanReview("verification_failed", {
      ...baseOverview,
      reviewerDecision: "rejected_verification_failed",
      reviewerReason: "Verification did not pass in the disposable workspace.",
      filesChanged: ["src/calculator.ts"]
    });
    expect(text).toContain("Operator verdict: do_not_apply");
    expect(text).toContain("Failure class: verification_failed");
    expect(text).toContain("Inspect verification-results.json");
    expect(text).not.toContain("ready_for_human_review");
  });

  it("dry-run apply failure has a clear next action", () => {
    const text = renderPatchSummary(null, "provider_rejected", ["patch failed dry-run apply"], {
      ...baseOverview,
      diagnostics: ["patch failed dry-run apply"]
    });
    expect(text).toContain("Failure class: dry_run_apply_failed");
    expect(text).toContain("Regenerate the patch against the current repo state");
    expect(text).toContain("do not hand-apply this patch");
  });

  it("malformed hunk failure has a clear rejection reason", () => {
    const text = renderPatchSummary(null, "provider_rejected", ["malformed diff for src/intervals.py"], {
      ...baseOverview,
      diagnostics: ["malformed diff for src/intervals.py"]
    });
    expect(text).toContain("Failure class: malformed_diff");
    expect(text).toContain("valid unified diff");
    expect(text).toContain("malformed diff for src/intervals.py");
  });
});
