import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePatchAuthority, loadAuthority, type AuthorityEnvelope } from "../../src/run/delegated-authority.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("delegated authority", () => {
  it("classifies missing and malformed authority", async () => {
    const repo = await tempDir();
    expect((await loadAuthority(undefined, repo)).classification).toBe("missing");
    const path = join(await tempDir(), "authority.json"); await writeFile(path, "{");
    expect((await loadAuthority(path, repo)).classification).toBe("invalid");
  });

  it("rejects a different repository and expired authority", async () => {
    const repo = await tempDir(); const other = await tempDir();
    expect((await load(repo, envelope(other))).classification).toBe("mismatched");
    expect((await load(repo, envelope(repo, { expires_at: "2020-01-01T00:00:00Z" }))).classification).toBe("expired");
  });

  it("rejects authority that relaxes network or provider hard-denies", async () => {
    const repo = await tempDir();
    for (const key of ["runtime_network", "provider_calls"]) {
      const value = envelope(repo); value.forbidden_actions[key] = false;
      expect((await load(repo, value)).classification).toBe("too_broad");
    }
  });

  it("rejects main and accepts the bounded envelope", async () => {
    const repo = await tempDir(); const unsafe = envelope(repo); unsafe.controlled_apply.branch_name = "main";
    expect((await load(repo, unsafe)).classification).toBe("too_broad");
    expect((await load(repo, envelope(repo))).classification).toBe("accepted");
  });

  it("rejects source files and controlled targets inside source", async () => {
    const repo = await tempDir(); const value = envelope(repo);
    expect(evaluatePatchAuthority(value, { files: ["src/index.ts"], risk: "low", controlledPath: join(await tempDir(), "controlled"), sourceRepo: repo }).classification).toBe("too_narrow");
    expect(evaluatePatchAuthority(value, { files: ["README.md"], risk: "low", controlledPath: join(repo, "artifacts", "controlled"), sourceRepo: repo }).classification).toBe("mismatched");
  });
});

async function tempDir(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "runforge-authority-")); roots.push(root); return root; }
async function load(repo: string, value: AuthorityEnvelope) { const dir = await tempDir(); const path = join(dir, "authority.json"); await writeFile(path, JSON.stringify(value)); return loadAuthority(path, repo); }
function envelope(repo: string, override: Partial<AuthorityEnvelope> = {}): AuthorityEnvelope {
  const actions = Object.fromEntries(["prepare_runtime", "run_baseline_validation", "perform_disposable_repair", "generate_patch_package", "run_providerless_review", "apply_to_controlled_artifact_worktree", "run_after_apply_validation", "generate_pr_creation_package"].map((key) => [key, true]));
  const forbidden = Object.fromEntries(["mutate_source_repo", "target_main_or_master", "push", "merge", "deploy", "provider_calls", "db_access", "production_access", "secret_access", "runtime_network", "create_external_pr"].map((key) => [key, true]));
  return { authority_id: "AUTHORITY-TEST", scope: "external-repair-demo", repo, allowed_actions: actions, forbidden_actions: forbidden, allowed_patch_risk: { max_risk: "low", allowed_file_patterns: ["README.md", "docs/**"], forbidden_file_patterns: [".env*", "**/secrets/**", "**/deploy/**", "**/migrations/**", "**/infra/**"] }, controlled_apply: { allowed: true, mode: "artifact-contained-worktree", branch_name: "runforge/test", requires_source_clean: true }, expires_at: null, owner_note: "test", ...override };
}
