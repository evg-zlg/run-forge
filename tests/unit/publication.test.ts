import { describe, expect, it } from "vitest";
import type { AuthorityEnvelope } from "../../src/run/delegated-authority.js";
import { assertExpectedRemoteBranch, evaluatePublicationAction, sourceMatchesBaseline, type PublicationAction } from "../../src/run/publication.js";
import type { RepoState } from "../../src/run/runtime-preparation.js";

describe("publication authority gates", () => {
  it.each(["main", "master", "develop", "source"])("rejects protected publication branch %s", (branch) => {
    expect(evaluatePublicationAction(authority(branch), input({ branch })).classification).toBe("mismatched");
  });
  it.each(["commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"] as PublicationAction[])("requires independent %s authority", (action) => {
    const value = authority(); value.allowed_actions[action] = false;
    expect(evaluatePublicationAction(value, input({ action })).classification).toBe("too_narrow");
  });
  it("rejects non-draft PR, dirty main, stale patch, and mismatched branch", () => {
    expect(evaluatePublicationAction(authority(), input({ action: "create_draft_pr", draft: false })).classification).toBe("too_broad");
    expect(evaluatePublicationAction(authority(), input({ sourceClean: false })).classification).toBe("stale");
    expect(evaluatePublicationAction(authority(), input({ currentPatchHash: "changed" })).classification).toBe("stale");
    expect(evaluatePublicationAction(authority("runforge/other"), input()).classification).toBe("mismatched");
  });
  it("rejects a clean source when HEAD changed after the baseline", () => {
    const baseline = repoState({ head: "baseline" });
    expect(sourceMatchesBaseline(repoState({ head: "changed" }), baseline)).toBe(false);
    expect(sourceMatchesBaseline(repoState({ status: " M README.md" }), baseline)).toBe(false);
    expect(sourceMatchesBaseline(repoState(), baseline)).toBe(true);
  });
  it("accepts each explicitly bounded publication action", () => {
    for (const action of ["commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"] as PublicationAction[]) expect(evaluatePublicationAction(authority(), input({ action })).classification).toBe("accepted");
  });
  it("rejects an unexpected existing remote head", () => {
    expect(() => assertExpectedRemoteBranch(null, "source")).not.toThrow(); expect(() => assertExpectedRemoteBranch("source", "source")).not.toThrow(); expect(() => assertExpectedRemoteBranch("other", "source")).toThrow("does not match");
  });
});

function input(override: Partial<Parameters<typeof evaluatePublicationAction>[1]> = {}): Parameters<typeof evaluatePublicationAction>[1] { return { action: "commit_to_non_main_branch", branch: "runforge/publication", sourceBranch: "source", defaultBranch: "develop", sourceClean: true, expectedPatchHash: "patch", currentPatchHash: "patch", draft: true, ...override }; }
function authority(branch = "runforge/publication"): AuthorityEnvelope {
  const actions = Object.fromEntries(["prepare_runtime", "run_baseline_validation", "perform_disposable_repair", "generate_patch_package", "run_providerless_review", "apply_to_controlled_artifact_worktree", "run_after_apply_validation", "generate_pr_creation_package", "create_or_update_local_non_main_branch", "commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"].map((key) => [key, true]));
  const forbidden = Object.fromEntries(["mutate_source_repo", "target_main_or_master", "push", "merge", "deploy", "provider_calls", "db_access", "production_access", "secret_access", "runtime_network", "create_external_pr", "force_push", "push_to_main"].map((key) => [key, true]));
  return { authority_id: "PUBLICATION-TEST", scope: "publication", repo: "/factory", allowed_actions: actions, forbidden_actions: forbidden, allowed_patch_risk: { max_risk: "low", allowed_file_patterns: ["README.md"], forbidden_file_patterns: [".env*"] }, controlled_apply: { allowed: true, mode: "artifact-contained-worktree", branch_name: "runforge/artifact", requires_source_clean: true }, local_branch_apply: { allowed: true, mode: "local-non-main-branch", branch_name: branch, requires_source_clean: true }, publication: { allowed: true, branch_name: branch, draft_only: true, pr_title: "Draft", commit_message: "Docs" }, expires_at: null, owner_note: "test" };
}

function repoState(override: Partial<RepoState> = {}): RepoState {
  return { path: "/factory", head: "baseline", status: "", ...override };
}
