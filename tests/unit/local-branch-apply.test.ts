import { describe, expect, it } from "vitest";
import { evaluateLocalBranchAuthority } from "../../src/run/local-branch-apply.js";
import type { AuthorityEnvelope } from "../../src/run/delegated-authority.js";

describe("local non-main branch authority", () => {
  it.each(["main", "master", "develop", "source"])('rejects protected branch "%s"', (targetBranch) => {
    expect(evaluateLocalBranchAuthority(authority(targetBranch), input({ targetBranch })).classification).toBe("mismatched");
  });

  it("rejects missing branch permission and mismatched target", () => {
    const missing = authority("runforge/demo"); missing.allowed_actions.create_or_update_local_non_main_branch = false;
    expect(evaluateLocalBranchAuthority(missing, input()).classification).toBe("too_narrow");
    expect(evaluateLocalBranchAuthority(authority("runforge/other"), input()).classification).toBe("mismatched");
  });

  it("rejects dirty source, unsafe worktree placement, and stale patch", () => {
    expect(evaluateLocalBranchAuthority(authority(), input({ sourceClean: false })).classification).toBe("stale");
    expect(evaluateLocalBranchAuthority(authority(), input({ worktreePath: "/factory/branch-worktree" })).classification).toBe("mismatched");
    expect(evaluateLocalBranchAuthority(authority(), input({ currentPatchHash: "changed" })).classification).toBe("stale");
  });

  it("accepts the exact authority-bound local branch contour", () => {
    expect(evaluateLocalBranchAuthority(authority(), input()).classification).toBe("accepted");
  });
});

function input(override: Partial<Parameters<typeof evaluateLocalBranchAuthority>[1]> = {}): Parameters<typeof evaluateLocalBranchAuthority>[1] {
  return { targetBranch: "runforge/demo", sourceBranch: "source", defaultBranch: "develop", sourceRepo: "/factory", worktreePath: "/artifacts/local-worktree", sourceClean: true, expectedPatchHash: "patch", currentPatchHash: "patch", ...override };
}

function authority(branch = "runforge/demo"): AuthorityEnvelope {
  const actions = Object.fromEntries(["prepare_runtime", "run_baseline_validation", "perform_disposable_repair", "generate_patch_package", "run_providerless_review", "apply_to_controlled_artifact_worktree", "run_after_apply_validation", "generate_pr_creation_package", "create_or_update_local_non_main_branch"].map((key) => [key, true]));
  const forbidden = Object.fromEntries(["mutate_source_repo", "target_main_or_master", "push", "merge", "deploy", "provider_calls", "db_access", "production_access", "secret_access", "runtime_network", "create_external_pr"].map((key) => [key, true]));
  return { authority_id: "BRANCH-TEST", scope: "local-branch", repo: "/factory", allowed_actions: actions, forbidden_actions: forbidden, allowed_patch_risk: { max_risk: "low", allowed_file_patterns: ["README.md"], forbidden_file_patterns: [".env*"] }, controlled_apply: { allowed: true, mode: "artifact-contained-worktree", branch_name: "runforge/artifact", requires_source_clean: true }, local_branch_apply: { allowed: true, mode: "local-non-main-branch", branch_name: branch, requires_source_clean: true }, expires_at: null, owner_note: "test" };
}
