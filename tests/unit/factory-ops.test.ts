import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFactoryOps } from "../../src/run/factory-ops.js";

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

  it("autopilot executes a deterministic low-risk candidate into a patch package", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-autopilot-"));
    const repo = join(root, "cli"); await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "cli", bin: { cli: "index.js" }, scripts: { test: "node --test", typecheck: "tsc --noEmit" }, dependencies: { commander: "1" } }));
    await writeFile(join(repo, "docs", "guide.md"), "# Guide  \n\nSafe text.\n");
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

  it("defaults a frontend repository with database indicators to read-only triage", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-smartsql-like-")); const repo = join(root, "app");
    await mkdir(join(repo, "prisma"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest run" }, dependencies: { react: "1", vite: "1" } }));
    await writeFile(join(repo, "prisma", "schema.prisma"), "model User { id Int @id }\n");
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
    const profiles = join(root, "profiles.json"); await writeFile(profiles, JSON.stringify({ "read-only-triage": { publication_permission: "none", forbidden_file_patterns: ["**/.env*", "**/migrations/**"] } }));
    const result = await runFactoryOps({ repo, profile: "auto-low-risk", batchSize: 1, out: join(root, "out"), profiles, cache: join(root, "cache"), registry: join(root, "missing.json"), autopilot: true });
    expect(result).toMatchObject({ selectedProfile: "read-only-triage", executed: 1, patchPackages: 1, targetUnchanged: true });
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });
});
