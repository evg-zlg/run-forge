import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("validation-only multi-lane execution", () => {
  it("executes package validation when if-needed can reuse source dependencies", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-validation-dependencies-"))) - 1]!;
    const repository = join(root, "source"); const artifacts = join(root, "artifacts"); const bin = join(root, "bin");
    await mkdir(repository); await mkdir(bin); await mkdir(join(repository, "node_modules"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "node --version" } }));
    await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const dockerLog = join(root, "docker.log"); const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
workspace=""; dependencies=""; last=""
for argument in "$@"; do
  case "$argument" in
    type=bind,src=*,dst=/workspace) workspace="\${argument#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace}" ;;
    type=bind,src=*/source/node_modules,dst=/source/node_modules,readonly) dependencies="available" ;;
  esac
  last="$argument"
done
test "$last" = "corepack pnpm test" || exit 91
test "$dependencies" = "available" || exit 92
printf 'package validation executed\\n'
`); await chmod(docker, 0o755);
    const specPath = join(root, "task-spec.json");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 2, taskId: "VALIDATION-DEPENDENCY-CAPABILITY-1",
      task: { text: "Run package validation with reusable dependencies.", goal: "Prove dependency capability planning.", acceptanceCriteria: ["Package validation executes"] },
      target: { repository, workingDirectory: ".", expectedSha: head }, execution: { mode: "validation", timeoutMs: 30_000 },
      executionAgreement: { schemaVersion: 1, profile: "assist-only" },
      runtime: { preference: "docker", dockerImage: "runforge:test", dependencyPreparation: "if-needed", externalNetwork: "denied" },
      validation: { mode: "explicit", commands: ["corepack pnpm test"] }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false },
      git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: artifacts },
    }));
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const execution = await runTaskSpecFile(specPath);
      expect(await readFile(dockerLog, "utf8")).toContain("/source/node_modules,dst=/source/node_modules,readonly");
      expect(execution).toMatchObject({ kind: "validation", success: true, result: { validationAggregate: "passed", source: { unchanged: true } } });
      const result = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"));
      expect(result.validationPlan.commands).toEqual([
        expect.objectContaining({ command: "corepack pnpm test", disposition: "execute", availableCapabilities: expect.arrayContaining(["package-manager", "dependencies"]) }),
      ]);
      expect(result.validation).toEqual([
        expect.objectContaining({ command: "corepack pnpm test", outcome: "passed", lane: "docker-validation", stdout: expect.stringContaining("package validation executed") }),
      ]);
      if (!("productWorkspace" in execution.result)) throw new Error("Expected the capability-aware validation-only executor result.");
      expect(await readlink(join(execution.result.productWorkspace, "node_modules"))).toBe("/source/node_modules");
      expect(await readFile(dockerLog, "utf8")).toContain("corepack pnpm test");
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()).toBe(head);
      expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repository, encoding: "utf8" }).trim()).toBe("");
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });

  it("runs product checks in Docker, Git evidence in its bound lane, and never spawns unsupported commands", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-validation-only-"))) - 1]!;
    const repository = join(root, "source"); const artifacts = join(root, "artifacts"); const bin = join(root, "bin");
    await mkdir(repository); await mkdir(bin);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "# fixture\n"); execFileSync("git", ["add", "README.md"], { cwd: repository }); execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const dockerLog = join(root, "docker.log"); const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
workspace=""; last=""
for argument in "$@"; do case "$argument" in type=bind,src=*,dst=/workspace*) workspace="\${argument#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace*}" ;; esac; last="$argument"; done
(cd "$workspace" && /bin/sh -lc "$last")
`); await chmod(docker, 0o755);
    const databaseCommand = "runforge-database-probe --read-only";
    const specPath = join(root, "task-spec.json");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 2, taskId: "VALIDATION-ONLY-REGRESSION-1",
      task: { text: "Run exact validation dogfood.", goal: "Prove multi-lane routing.", acceptanceCriteria: ["All supported evidence passes"] },
      target: { repository, workingDirectory: ".", expectedSha: head }, execution: { mode: "validation", timeoutMs: 30_000 },
      executionAgreement: { schemaVersion: 1, profile: "assist-only" },
      runtime: { preference: "docker", dockerImage: "runforge:test", dependencyPreparation: "disabled", externalNetwork: "denied" },
      validation: { mode: "explicit", commands: ["node --version", "test ! -d .git", "git diff --check", databaseCommand], requirements: [
        { command: "node --version", capabilities: ["filesystem", "shell"], acceptance: "required", evidenceRole: "product-validation" },
        { command: "test ! -d .git", capabilities: ["filesystem", "shell"], acceptance: "required", evidenceRole: "product-validation" },
        { command: "git diff --check", capabilities: ["git-read-only-evidence"], acceptance: "evidence-only", evidenceRole: "git-evidence" },
        { command: databaseCommand, capabilities: ["database"], acceptance: "optional", evidenceRole: "database-evidence" },
      ] }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: artifacts },
    }));
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const execution = await runTaskSpecFile(specPath);
      expect(execution).toMatchObject({ kind: "validation", success: true, result: { status: "completed", validationAggregate: "completed_with_validation_gaps", source: { unchanged: true } } });
      const result = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"));
      expect(result).toMatchObject({ status: "workflow_completed", validationAggregate: "completed_with_validation_gaps", review: { structural: { status: "completed_with_validation_gaps" }, semantic: { status: "unavailable", delegation: { party: "external_session" } } } });
      expect(result.validation).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "node --version", outcome: "passed", lane: "docker-validation", executor: "docker-shell" }),
        expect.objectContaining({ command: "test ! -d .git", outcome: "passed", lane: "docker-validation", executor: "docker-shell" }),
        expect.objectContaining({ command: "git diff --check", outcome: "passed", lane: "git-evidence", boundSha: head, safetyAssertions: expect.arrayContaining(["argv_only_no_shell", "source_state_immutable"]) }),
        expect.objectContaining({ command: databaseCommand, outcome: "capability_unsupported", exitCode: null, missingCapabilities: ["database"] }),
      ]));
      const product = result.validation.find((item: { command: string }) => item.command === "node --version");
      await expect(access(join(product.cwd, ".git"))).rejects.toThrow();
      const spawned = await readFile(dockerLog, "utf8"); expect(spawned).not.toContain("git diff --check"); expect(spawned).not.toContain(databaseCommand);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()).toBe(head);
      expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repository, encoding: "utf8" }).trim()).toBe("");
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});
