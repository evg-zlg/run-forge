import { describe, expect, it } from "vitest";
import { evaluateAutopilotPromotion } from "../../src/run/factory-ops.js";

const profile = { publication_permission: "draft_pr", allowed_actions: ["promote_patch_package_to_branch", "commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"], forbidden_file_patterns: ["**/.env*"] };
const valid = { profile, branch: "runforge/candidate", sourceBranch: "source", defaultBranch: "main", sourceClean: true, patchHashMatches: true, validationPassed: true, draft: true, runtimeNetworkRequired: false, forbiddenFile: false };

describe("normal autopilot promotion policy", () => {
  it("promotes only a clean, validated, low-risk draft with complete authority", () => expect(evaluateAutopilotPromotion(valid)).toMatchObject({ allowed: true, outcome: "draft-pr-created" }));
  it("refuses absent action authority", () => expect(evaluateAutopilotPromotion({ ...valid, profile: { ...profile, allowed_actions: profile.allowed_actions.slice(1) } })).toMatchObject({ allowed: false, outcome: "patch-package-ready" }));
  it.each(["main", "master", "source"])("refuses protected branch %s", (branch) => expect(evaluateAutopilotPromotion({ ...valid, branch })).toMatchObject({ allowed: false, outcome: "rejected-policy" }));
  it("refuses dirty source and stale patch", () => {
    expect(evaluateAutopilotPromotion({ ...valid, sourceClean: false }).outcome).toBe("unsafe/not-runnable");
    expect(evaluateAutopilotPromotion({ ...valid, patchHashMatches: false }).outcome).toBe("unsafe/not-runnable");
  });
  it("refuses failed validation, non-draft PR, runtime network, and forbidden files", () => {
    expect(evaluateAutopilotPromotion({ ...valid, validationPassed: false }).outcome).toBe("validation-failed");
    for (const override of [{ draft: false }, { runtimeNetworkRequired: true }, { forbiddenFile: true }]) expect(evaluateAutopilotPromotion({ ...valid, ...override }).outcome).toBe("rejected-policy");
  });
});
