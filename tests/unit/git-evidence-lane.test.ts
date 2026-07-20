import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { aggregateValidationOutcomes, buildMultiLaneValidationPreflightPlan, normalizeValidationRequirements, runtimeCapabilities } from "../../src/validation/capability-contract.js";
import { createGitEvidenceBinding, executeGitEvidence, parseGitEvidenceCommand, sourceFingerprint } from "../../src/validation/git-evidence-lane.js";
import { runValidation } from "../../src/implementation/validation-command-runner.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("SHA-bound Git evidence lane", () => {
  it("runs status, diff check, rev-parse, merge-base, changed paths, and preserves source bytes", async () => {
    const { repo, workspace, head, parent } = await fixture();
    await writeFile(join(workspace, "file.txt"), "changed without whitespace errors\n");
    const binding = await createGitEvidenceBinding({ targetRepository: repo, evidenceWorkspace: workspace, expectedSha: head });
    const before = await sourceFingerprint(repo);
    const commands = [
      "git status --porcelain", "git diff --check", `git diff --check ${parent}..${head}`,
      "git rev-parse HEAD", `git merge-base ${parent} ${head}`, "git diff --name-only",
      `git diff --name-only ${parent}..${head}`,
    ];
    const results = [];
    for (const command of commands) results.push(await executeGitEvidence({ binding, command, timeoutMs: 5_000 }));
    expect(results.every((item) => item.exitCode === 0 && item.sourceUnchanged)).toBe(true);
    expect(results[0]!.stdout).toContain("file.txt");
    expect(results[3]!.stdout.trim()).toBe(head);
    expect(results[3]!.argv).toEqual(["git", "rev-parse", head]);
    expect(results[4]!.stdout.trim()).toBe(parent);
    expect(results[5]!.stdout.trim()).toBe("file.txt");
    expect(await sourceFingerprint(repo)).toBe(before);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  it("routes a Docker/file-only product lane and Git evidence to separate lanes", async () => {
    const { repo, workspace, head } = await fixture();
    const binding = await createGitEvidenceBinding({ targetRepository: repo, evidenceWorkspace: workspace, expectedSha: head });
    const normalized = normalizeValidationRequirements({ commands: ["node --version", "git diff --check"], mode: "explicit" });
    const plan = buildMultiLaneValidationPreflightPlan({
      ...normalized,
      productLane: { ...runtimeCapabilities({ runtime: "docker", hasGitMetadata: false, docker: true }), cwd: "/source" },
      gitLane: { runtime: "git-evidence", lane: "git-evidence", cwd: workspace, available: ["filesystem", "git-read-only-evidence", "git-metadata", "git-history", "working-tree-index", "local-disposable"], repositoryIdentity: binding.repositoryIdentity, boundSha: head, safetyAssertions: binding.safetyAssertions },
      parseGit: (command) => { const parsed = parseGitEvidenceCommand(command, head); return parsed.supported ? { ...parsed, reason: "supported" } : parsed; },
      now: new Date("2026-07-20T00:00:00.000Z"),
    });
    expect(plan.lanes?.map((lane) => lane.lane)).toEqual(["docker-validation", "git-evidence"]);
    expect(plan.commands[0]).toMatchObject({ lane: "docker-validation", cwd: "/source", disposition: "execute" });
    expect(plan.commands[1]).toMatchObject({ lane: "git-evidence", cwd: workspace, disposition: "execute", argv: ["git", "diff", "--no-ext-diff", "--no-textconv", "--check"], repositoryIdentity: binding.repositoryIdentity, boundSha: head });
    const schema = JSON.parse(await readFile("schemas/task-result-v1.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile({ ...schema.$defs.validationPlan, $defs: schema.$defs });
    expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    "git status --porcelain; touch OWNED", "git status --porcelain && touch OWNED", "git status --porcelain > OWNED",
    "git rev-parse $(touch OWNED)", "git -c core.hooksPath=. status --porcelain", "git -c credential.helper=x status --porcelain",
    "git add .", "git commit -m bad", "git reset --hard", "git checkout main", "git clean -fd", "git fetch origin",
    "git pull", "git push", "git clone https://example.invalid/x", "git remote -v", "git submodule update", "git diff --check main",
    "git rev-parse @", "git rev-parse HEAD~1", "git rev-parse refs/heads/main", "git rev-parse refs/tags/release",
    "git diff --check refs/heads/main..HEAD", "git merge-base refs/tags/release HEAD", "git merge-base --octopus HEAD HEAD",
  ])("rejects unsupported or hostile form before spawn: %s", async (command) => {
    expect(parseGitEvidenceCommand(command)).toMatchObject({ supported: false });
  });

  it("does not execute malicious composition and blocks repository/SHA mismatch", async () => {
    const first = await fixture();
    const second = await fixture();
    const sentinel = join(first.workspace, "OWNED");
    const binding = await createGitEvidenceBinding({ targetRepository: first.repo, evidenceWorkspace: first.workspace, expectedSha: first.head });
    await expect(executeGitEvidence({ binding, command: "git status --porcelain; touch OWNED", timeoutMs: 5_000 })).rejects.toThrow("capability_unsupported");
    await expect(readFile(sentinel)).rejects.toThrow();
    await expect(createGitEvidenceBinding({ targetRepository: second.repo, evidenceWorkspace: first.workspace, expectedSha: first.head })).rejects.toThrow("repository_identity_mismatch");
    await expect(createGitEvidenceBinding({ targetRepository: first.repo, evidenceWorkspace: first.workspace, expectedSha: first.parent })).rejects.toThrow("sha_mismatch");
  });

  it("neutralizes repository-local external diff and textconv helpers", async () => {
    const { repo, workspace, head } = await fixture();
    const sentinel = join(repo, "HELPER_EXECUTED");
    const helper = join(repo, "malicious-diff-helper.sh");
    await writeFile(helper, `#!/bin/sh\ntouch ${sentinel}\n`);
    await chmod(helper, 0o755);
    await writeFile(join(workspace, ".gitattributes"), "file.txt diff=malicious\n");
    await git(workspace, ["config", "diff.malicious.command", helper]);
    await git(workspace, ["config", "diff.malicious.textconv", helper]);
    await writeFile(join(workspace, "file.txt"), "changed\n");
    const binding = await createGitEvidenceBinding({ targetRepository: repo, evidenceWorkspace: workspace, expectedSha: head });
    for (const command of ["git diff --check", "git diff --name-only"]) {
      const result = await executeGitEvidence({ binding, command, timeoutMs: 5_000 });
      expect(result.exitCode).toBe(0);
      expect(result.argv).toContain("--no-ext-diff");
      expect(result.argv).toContain("--no-textconv");
    }
    await expect(readFile(sentinel)).rejects.toThrow();
  });

  it("turns unavailable and lost bindings into capability outcomes", async () => {
    const { repo, workspace, head, parent } = await fixture();
    const binding = await createGitEvidenceBinding({ targetRepository: repo, evidenceWorkspace: workspace, expectedSha: head });
    const normalized = normalizeValidationRequirements({
      commands: ["git diff --check"], mode: "explicit",
      requirements: [{ command: "git diff --check", acceptance: "required" }],
    });
    const unavailable = buildMultiLaneValidationPreflightPlan({
      ...normalized,
      productLane: { ...runtimeCapabilities({ runtime: "docker", hasGitMetadata: false, docker: true }), cwd: "/source" },
      gitLaneUnavailableReason: "capability_unsupported: git_evidence_repository_identity_mismatch",
      parseGit: (command) => { const parsed = parseGitEvidenceCommand(command, head); return parsed.supported ? { ...parsed, reason: "supported" } : parsed; },
    });
    expect(unavailable.commands[0]).toMatchObject({ disposition: "capability_unsupported", reason: "capability_unsupported: git_evidence_repository_identity_mismatch" });
    const executable = { ...unavailable.commands[0]!, supported: true, disposition: "execute" as const, cwd: workspace, repositoryIdentity: binding.repositoryIdentity, boundSha: head };
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-git-artifacts-")); roots.push(artifactRoot);
    const lostBinding = { ...binding, boundSha: parent };
    const outcome = await runValidation(executable, artifactRoot, 0, 0, 5_000, undefined, lostBinding);
    expect(outcome).toMatchObject({ outcome: "capability_unsupported", setupFailure: false, classification: null });
    expect(aggregateValidationOutcomes([{ command: outcome.command, acceptance: outcome.acceptance, outcome: outcome.outcome, exitCode: outcome.exitCode, reason: outcome.failureReason, evidenceRole: outcome.evidenceRole }])).toBe("blocked_by_capability");
    await expect(executeGitEvidence({ binding: { ...binding, safetyAssertions: [] }, command: "git status --porcelain", timeoutMs: 5_000 })).rejects.toThrow("safety_binding_incomplete");
  });

  it("keeps optional unsupported gaps non-blocking and required unsupported blocking", () => {
    const unsupported = (acceptance: "required" | "optional") => ({ command: "git fetch", acceptance, outcome: "capability_unsupported" as const, exitCode: null, reason: "unsupported", evidenceRole: "git-evidence" });
    expect(aggregateValidationOutcomes([unsupported("optional")])).toBe("completed_with_validation_gaps");
    expect(aggregateValidationOutcomes([unsupported("required")])).toBe("blocked_by_capability");
  });
});

async function fixture(): Promise<{ repo: string; workspace: string; head: string; parent: string }> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-git-source-")); roots.push(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "file.txt"), "first\n");
  await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "first"]);
  const parent = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(repo, "file.txt"), "second\n");
  await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "second"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const workspace = await mkdtemp(join(tmpdir(), "runforge-git-evidence-")); roots.push(workspace); await rm(workspace, { recursive: true });
  await git(repo, ["worktree", "add", "--detach", workspace, head]);
  return { repo, workspace, head, parent };
}
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", ["-C", cwd, ...args])).stdout; }
