import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { recordFactoryCandidateVerdict, runFactoryOps } from "../../src/run/factory-ops.js";

describe("factory ops", () => {
  it("discovers bounded candidates and preserves the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-ops-"));
    const repo = join(root, "repo"); await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "note.md"), "TODO document the safe command\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const registry = join(root, "projects.json"); const profiles = join(root, "profiles.json"); const out = join(root, "out");
    await writeFile(registry, JSON.stringify({ demo: { path: repo, risk: "test", default_profile: "read-only" } }));
    await writeFile(profiles, JSON.stringify({ "read-only": { publication_permission: "none" } }));
    const result = await runFactoryOps({ project: "demo", batchSize: 2, out, registry, profiles });
    expect(result).toMatchObject({ candidates: 1, selected: 1, targetUnchanged: true });
    expect(await readFile(join(out, "owner-inbox.md"), "utf8")).toContain("Owner inbox");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("onboards an unknown repository without a registry entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-unknown-"));
    const repo = join(root, "unknown-app"); await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "unknown-app", scripts: { test: "vitest run", build: "vite build" }, dependencies: { react: "1", vite: "1" } }));
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(repo, "src", "index.ts"), "export const ready = true;\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const out = join(root, "out"); const cache = join(root, "cache");
    await writeFile(profiles, JSON.stringify({ "frontend-low-risk": { publication_permission: "draft_pr" } }));
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 2, out, profiles, cache, registry: join(root, "missing-registry.json") });
    expect(result.recommendedProfile).toBe("frontend-low-risk");
    const profile = JSON.parse(await readFile(join(out, "projects", result.project, "project-profile.json"), "utf8"));
    expect(profile).toMatchObject({ package_manager: "pnpm", frameworks: expect.arrayContaining(["react", "vite"]) });
    expect(await readFile(result.cacheProfile, "utf8")).toContain('"source_repo_path"');
  });

  it("suppresses only an owner-reviewed candidate fingerprint and permits explicit reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-verdict-")); const repo = join(root, "cli"); await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "cli", bin: "scripts/tool.mjs", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
    await writeFile(join(repo, "scripts", "tool.mjs"), "export function run(argv = process.argv.slice(2)) { return argv; }\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const cache = join(root, "cache"); const firstOut = join(root, "batch-2");
    await writeFile(profiles, JSON.stringify({ "cli-tooling-low-risk": { publication_permission: "draft_pr", allowed_actions: ["create_patch_package"], allowed_file_patterns: ["scripts/tool.mjs"] } }));
    const candidate = "cli-argument-handling-scripts-tool-mjs";
    const verdict = await recordFactoryCandidateVerdict({ repo, candidate, verdict: "reviewed_no_change", classification: "false_positive", reason: "Existing behavior matches the owner contract.", checks: ["targeted tests passed"], out: firstOut, cache });
    expect(verdict).toMatchObject({ candidate, targetUnchanged: true });
    const suppressed = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out: join(root, "batch-3"), profiles, cache, registry: join(root, "missing.json"), autopilot: true });
    expect(suppressed).toMatchObject({ selected: 0, ownerDecisions: 0 });
    expect(await readFile(join(root, "batch-3", "promotion-report.md"), "utf8")).toContain("reviewed-no-change");
    const reopened = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out: join(root, "reopened"), profiles, cache, registry: join(root, "missing.json"), autopilot: true, reopenCandidates: [candidate] });
    expect(reopened).toMatchObject({ selected: 1, ownerDecisions: 1 });
  });

  it("uses the canonical project key when a registry alias is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-alias-verdict-")); const repo = join(root, "cli"); await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "stable-cli", bin: "scripts/tool.mjs", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
    await writeFile(join(repo, "scripts", "tool.mjs"), "export function run(argv = process.argv.slice(2)) { return argv; }\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const cache = join(root, "cache"); const registry = join(root, "projects.json");
    await writeFile(profiles, JSON.stringify({ "cli-tooling-low-risk": { publication_permission: "draft_pr", allowed_actions: ["create_patch_package"], allowed_file_patterns: ["scripts/tool.mjs"] } }));
    await writeFile(registry, JSON.stringify({ friendly: { path: repo, risk: "test", default_profile: "cli-tooling-low-risk" } }));
    const candidate = "cli-argument-handling-scripts-tool-mjs";
    const verdict = await recordFactoryCandidateVerdict({ repo, candidate, verdict: "reviewed_no_change", classification: "false_positive", reason: "Existing behavior is intentional.", checks: ["targeted tests passed"], out: join(root, "verdict"), cache });
    const result = await runFactoryOps({ project: "friendly", batchSize: 1, out: join(root, "run"), profiles, cache, registry, autopilot: true });
    expect(result).toMatchObject({ project: expect.stringMatching(/^stable-cli-/), selected: 0, ownerDecisions: 0 });
    expect(result.project).not.toBe("friendly");
    expect(verdict.project).toBe(result.project);
  });

  it("autopilot executes a deterministic low-risk candidate into a patch package", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-autopilot-"));
    const repo = join(root, "cli"); await mkdir(join(repo, "docs"), { recursive: true }); await mkdir(join(repo, "prisma", "migrations", "001"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "cli", bin: { cli: "index.js" }, scripts: { test: "node --test", typecheck: "tsc --noEmit" }, dependencies: { commander: "1" } }));
    await writeFile(join(repo, "docs", "guide.md"), "# Guide  \n\nSafe text.\n");
    await writeFile(join(repo, "prisma", "schema.prisma"), "model Run { id Int @id }\n"); await writeFile(join(repo, "prisma", "migrations", "001", "up.sql"), "select 1;\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const out = join(root, "out");
    await writeFile(profiles, JSON.stringify({ "cli-tooling-low-risk": { publication_permission: "draft_pr", allowed_actions: ["create_patch_package"], allowed_file_patterns: ["docs/**"] } }));
    const before = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 3, out, profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(result).toMatchObject({ selectedProfile: "cli-tooling-low-risk", executed: 1, patchPackages: 1, targetUnchanged: true });
    const candidate = join(out, "projects", result.project, "candidates", "trim-docs-guide-md");
    expect(await readFile(join(candidate, "patch-package", "patch.diff"), "utf8")).toContain("-# Guide  ");
    expect(await readFile(join(candidate, "classification.json"), "utf8")).toContain("patch-package-ready");
    expect(await readFile(join(candidate, "patch-package", "risk-assessment.md"), "utf8")).toContain("deterministic patch");
    expect(await readFile(join(candidate, "patch-package", "owner-next-action.md"), "utf8")).toContain("non-main worktree");
    execFileSync("git", ["-C", repo, "apply", "--check", join(candidate, "patch-package", "patch.diff")]);
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(before);
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("discovers broad CLI candidates and ranks executable work ahead of policy decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-yield-")); const repo = join(root, "cli");
    await mkdir(join(repo, "src", "commands"), { recursive: true }); await mkdir(join(repo, "tests"), { recursive: true }); await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "yield-cli", bin: { yield: "src/cli.ts" }, scripts: { test: "vitest run", lint: "eslint ." }, dependencies: { commander: "1" } }));
    await writeFile(join(repo, "src", "cli.ts"), "const values = process.argv.slice(2);\nconst count = parseInt(values[0]);\nJSON.parse(values[1]);\n");
    await writeFile(join(repo, "tests", "cli.test.ts"), "JSON.parse('{bad');\n// TODO cover an empty argument\n");
    await writeFile(join(repo, "docs", "commands.md"), "# Commands  \n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const out = join(root, "out");
    await writeFile(profiles, JSON.stringify({ "cli-tooling-low-risk": { publication_permission: "patch_package", allowed_actions: ["create_patch_package"], allowed_file_patterns: ["src/**", "tests/**", "docs/**"] } }));
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out, profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(result).toMatchObject({ candidates: 7, selected: 1, executed: 1, patchPackages: 1, ownerDecisions: 1 });
    const report = await readFile(join(out, "projects", result.project, "candidate-selection-report.md"), "utf8");
    expect(report).toContain("validation-typecheck-gap");
    expect(report).toContain("trim-docs-commands-md`:");
  });

  it("keeps a SmartSQL-like DB/production repository on read-only triage", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-smartsql-like-")); const repo = join(root, "app");
    await mkdir(join(repo, "prisma", "migrations", "001"), { recursive: true }); await mkdir(join(repo, "db", "migrations", "002"), { recursive: true }); await mkdir(join(repo, "production"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest run" }, dependencies: { react: "1", vite: "1" } }));
    await writeFile(join(repo, "prisma", "schema.prisma"), "model User { id Int @id }\n");
    await writeFile(join(repo, "prisma", "migrations", "001", "up.sql"), "select 1;\n"); await writeFile(join(repo, "db", "migrations", "002", "up.sql"), "select 1;\n"); await writeFile(join(repo, "production", "database.ts"), "export {};\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); await writeFile(profiles, JSON.stringify({ "read-only-triage": { publication_permission: "none" } }));
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out: join(root, "out"), profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(result).toMatchObject({ recommendedProfile: "read-only-triage", selectedProfile: "read-only-triage", executed: 0, targetUnchanged: true });
  });

  it("uses a patch-package-only fallback when publication is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-readonly-package-")); const repo = join(root, "app");
    await mkdir(join(repo, "docs"), { recursive: true }); await mkdir(join(repo, "prisma"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest run" }, dependencies: { react: "1" } }));
    await writeFile(join(repo, "docs", "guide.md"), "# Safe guide  \n"); await writeFile(join(repo, "prisma", "schema.prisma"), "model User { id Int @id }\n");
    execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); await writeFile(profiles, JSON.stringify({ "frontend-low-risk": { publication_permission: "patch_package", allowed_actions: ["create_patch_package"], allowed_file_patterns: ["docs/**"], forbidden_file_patterns: ["**/.env*", "**/migrations/**"] } }));
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out: join(root, "out"), profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(result).toMatchObject({ selectedProfile: "frontend-low-risk", executed: 1, patchPackages: 1, targetUnchanged: true });
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("rejects a deterministic candidate outside the profile allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-profile-files-")); const repo = join(root, "app");
    await mkdir(join(repo, "docs"), { recursive: true }); await writeFile(join(repo, "package.json"), JSON.stringify({ name: "cli", bin: "index.js", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
    await writeFile(join(repo, "docs", "guide.md"), "# Guide  \n"); execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
    const profiles = join(root, "profiles.json"); const out = join(root, "out"); await writeFile(profiles, JSON.stringify({ "cli-tooling-low-risk": { publication_permission: "draft_pr", allowed_actions: ["create_patch_package", "promote_patch_package_to_branch", "commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"], allowed_file_patterns: ["src/**"] } }));
    await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out, profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(await readFile(join(out, "projects", (await readdir(join(out, "projects")))[0]!, "candidates", "trim-docs-guide-md", "classification.json"), "utf8")).toContain("needs-owner-decision");
  });
});
