import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("TaskSpec owner gates", () => {
  it("writes an official owner gate and exact continuation when runtime policy blocks execution", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-gate-"))) - 1]!;
    const repo = join(root, "repo"); const artifacts = join(root, "artifacts"); const specPath = join(root, "task.json");
    await execFileAsync("git", ["init", "-b", "main", repo]);
    await writeFile(join(repo, "README.md"), "# target\n");
    await execFileAsync("git", ["-C", repo, "add", "."]);
    await execFileAsync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 2, taskId: "LOCAL-DENIED-1", task: { text: "Inspect", goal: "Evidence", acceptanceCriteria: ["Command passes"] },
      target: { repository: repo }, execution: { mode: "validation" }, runtime: { preference: "local-disposable", dependencyPreparation: "disabled" },
      validation: { mode: "explicit", commands: ["node --version"] }, artifacts: { root: artifacts }
    }));
    await expect(runTaskSpecFile(specPath)).rejects.toThrow("disposable local workspace");
    const result = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"));
    expect(result).toMatchObject({ status: "blocked", ownerGate: { required: true, status: "awaiting_owner_decision", reason: expect.stringContaining("disposable local workspace") } });
    expect(result.ownerGate.continuationCommand).toContain("task-spec.normalized.json");
    expect(JSON.parse(await readFile(join(artifacts, "task-spec.normalized.json"), "utf8"))).toMatchObject({ target: { workingDirectory: "." }, runtime: { preference: "local-disposable" } });
  });

  it("executes an authority-bounded repair in a local disposable workspace", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-local-repair-"))) - 1]!;
    const repo = join(root, "repo"); const artifacts = join(root, "artifacts");
    await execFileAsync("git", ["init", "-b", "main", repo]);
    await mkdir(join(repo, "frontend"));
    await writeFile(join(repo, "frontend", "README.md"), "before\n");
    await writeFile(join(repo, "frontend", "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    await execFileAsync("git", ["-C", repo, "add", "."]); await execFileAsync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    const actions = Object.fromEntries(["prepare_runtime", "run_baseline_validation", "perform_disposable_repair", "generate_patch_package", "run_providerless_review", "apply_to_controlled_artifact_worktree", "run_after_apply_validation", "generate_pr_creation_package"].map((key) => [key, true]));
    const forbidden = Object.fromEntries(["mutate_source_repo", "target_main_or_master", "push", "merge", "deploy", "provider_calls", "db_access", "production_access", "secret_access", "runtime_network", "create_external_pr", "force_push", "push_to_main"].map((key) => [key, true]));
    const authority = join(root, "authority.json"); const plan = join(root, "plan.json"); const specPath = join(root, "task.json");
    await writeFile(authority, JSON.stringify({ authority_id: "LOCAL-REPAIR", scope: "test", repo, allowed_actions: actions, forbidden_actions: forbidden, allowed_patch_risk: { max_risk: "low", allowed_file_patterns: ["frontend/README.md"], forbidden_file_patterns: [".env*"] }, controlled_apply: { allowed: true, mode: "artifact-contained-worktree", branch_name: "runforge/test", requires_source_clean: true }, expires_at: null, owner_note: "test" }));
    await writeFile(plan, JSON.stringify({ schema_version: "runforge.code-repair.v1", candidate_id: "LOCAL", task: "Update docs", allowed_files: ["README.md"], max_changed_files: 1, validation_commands: ["npm test"], changes: [{ file: "README.md", replacements: [{ find: "before", replace: "after" }] }] }));
    await writeFile(specPath, JSON.stringify({ schemaVersion: 2, taskId: "LOCAL-REPAIR-1", task: { text: "Update docs", goal: "Apply bounded change", acceptanceCriteria: ["Patch is validated"] }, target: { repository: repo, workingDirectory: "frontend" }, execution: { mode: "repair" }, runtime: { preference: "local-disposable", dependencyPreparation: "disabled", externalNetwork: "denied" }, validation: { mode: "explicit", commands: ["npm test"] }, authority: { profile: "bounded-implementation", envelopeFile: authority }, artifacts: { root: artifacts }, repair: { mode: "code", plan } }));
    const execution = await runTaskSpecFile(specPath);
    expect(execution.success).toBe(true);
    const canonical = await realpath(repo);
    expect(JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"))).toMatchObject({ status: "completed", targetRepository: { repositoryRoot: canonical, executionRoot: join(canonical, "frontend"), changed: false } });
    expect(JSON.parse(await readFile(join(artifacts, "continuation-state.json"), "utf8"))).toMatchObject({ runtime: "local", workingDirectory: "frontend", dependencyPreparation: "disabled" });
    expect(await readFile(join(repo, "frontend", "README.md"), "utf8")).toBe("before\n");
  });
});
