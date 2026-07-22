import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resumeDurableCheckpoint } from "../../src/implementation/checkpoint-resume.js";
import { persistDurableCheckpoint, readDurableCheckpoint } from "../../src/implementation/durable-checkpoint.js";
import { prepareTaskOwnedDependencies } from "../../src/implementation/workspace-continuity.js";
import { acceptCompletedResult } from "../../src/control-plane/completed-result-acceptance.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";

const exec = promisify(execFile);

describe("restart-safe checkpoint resume", () => {
  it("reconstructs base plus patch after restart, validates without provider calls, and replays idempotently", async () => {
    const fixture = await resumeFixture("node test.js");
    const first = await resumeDurableCheckpoint(fixture.context);
    expect(first).toMatchObject({ status: "validated", providerCalls: 0, providerRerun: false, reconstruction: { implementationWorkspaceId: "implementation-workspace", reconstructionMethod: "git_worktree_base_plus_binary_patch", baseSha: fixture.baseSha } });
    const replay = await resumeDurableCheckpoint({ ...fixture.context, task: structuredClone(fixture.context.task) });
    expect(replay).toMatchObject({ idempotentReplay: true, generation: first.generation, providerCalls: 0 });
    expect((await readDurableCheckpoint(fixture.artifactRoot, "checkpoint-0"))?.manifest).toMatchObject({ schemaVersion: 2, status: "validated", sequence: 2 });
  });

  it("returns structured wrong_identity and binary integrity errors with portable handoff", async () => {
    const fixture = await resumeFixture("node test.js");
    await expect(resumeDurableCheckpoint({ ...fixture.context, request: { ...fixture.context.request, projectId: "copied-project" } })).rejects.toMatchObject({ code: "wrong_identity", status: 409, details: { portableHandoff: { checkpointId: "checkpoint-0" } } });
    const other = await resumeFixture("node test.js");
    await expect(resumeDurableCheckpoint({ ...other.context, request: { ...other.context.request, candidateBinary: { ...other.context.request.candidateBinary, sha256: "0".repeat(64) } } })).rejects.toMatchObject({ code: "checkpoint_integrity_error", status: 409 });
  });

  it("validates execution agreement subset and rejects mismatches", async () => {
    const fixture = await resumeFixture("node test.js");
    await expect(resumeDurableCheckpoint({
      ...fixture.context,
      request: { ...fixture.context.request, executionAgreementId: "ea_v1_bbbbbbbbbbbbbbbbbbbbbbbb" }
    })).rejects.toMatchObject({ code: "wrong_identity", status: 409, details: { portableHandoff: { checkpointId: "checkpoint-0" } } });

    const badAgreement = { ...fixture.context.task.executionAgreement, profile: "mismatched-profile" };
    await expect(resumeDurableCheckpoint({
      ...fixture.context,
      task: { ...fixture.context.task, executionAgreement: badAgreement }
    })).rejects.toMatchObject({ code: "wrong_identity", status: 409, details: { portableHandoff: { checkpointId: "checkpoint-0" } } });
  });

  it("accepts candidate-binary validation evidence without a provider rerun", async () => {
    const fixture = await resumeFixture("node test.js"); await resumeDurableCheckpoint(fixture.context);
    await writeFile(join(fixture.artifactRoot, "results.json"), JSON.stringify({ artifact: { checkpoints: [{ id: "checkpoint-0", validationPassed: false }] }, git: {}, usage: {}, handoffPackage: {} }) + "\n");
    const store = new ControlPlaneStore(join(fixture.root, "state")); await store.initialize(); const task: any = { ...fixture.context.task, decisions: [], ownerGate: { required: true, status: "pending" }, events: [], updatedAt: new Date().toISOString() };
    const accepted = await acceptCompletedResult({ task, request: { decisionId: "accept-candidate", checkpointId: "checkpoint-0", delivery: "patch" }, store, persist: async () => undefined });
    expect(accepted).toMatchObject({ status: "accepted", providerCalls: 0, providerRerun: false, candidateValidation: { binarySha256: fixture.context.request.candidateBinary.sha256 } });
    expect((await readDurableCheckpoint(fixture.artifactRoot, "checkpoint-0"))?.manifest).toMatchObject({ status: "accepted", sequence: 3 });
  });

  it("conflicts a concurrent generation and ignores implementation providers", async () => {
    const fixture = await resumeFixture("node -e \"setTimeout(() => {}, 150)\"");
    const active = resumeDurableCheckpoint(fixture.context); await new Promise((done) => setTimeout(done, 20));
    await expect(resumeDurableCheckpoint(fixture.context)).rejects.toMatchObject({ code: "conflict", status: 409, retryable: true });
    expect(await active).toMatchObject({ providerCalls: 0, status: "validated" });
  });

  it("repairs only task-owned broken cache links and preserves external EEXIST objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-deps-")), workspace = join(root, "workspace"), cache = join(root, "cache"); await mkdir(workspace); await mkdir(cache); await writeFile(join(cache, "module.js"), "ok\n"); await chmod(join(cache, "module.js"), 0o444); await chmod(cache, 0o555);
    const digest = await cacheDigest(cache), base = { taskId: "TASK-DEP-1", workspaceId: "workspace-1", workspaceRoot: workspace, executionRoot: workspace, strategy: "verified_read_only_cache" as const, cacheRoot: cache, cacheSha256: digest };
    await writeFile(join(workspace, "node_modules"), "external");
    const external = await prepareTaskOwnedDependencies(base); expect(external.detail).toBe("External dependency object was preserved."); expect(external).toMatchObject({ classification: "conflict_external", owned: false });
    await import("node:fs/promises").then(({ rm }) => rm(join(workspace, "node_modules"))); const created = await prepareTaskOwnedDependencies(base); expect(created.classification).toBe("created");
    await import("node:fs/promises").then(({ rm }) => rm(join(workspace, "node_modules"))); await symlink(join(root, "missing"), join(workspace, "node_modules"), "dir");
    expect(await prepareTaskOwnedDependencies(base)).toMatchObject({ classification: "repaired", owned: true });
  });
});

async function resumeFixture(command: string) {
  const root = await mkdtemp(join(tmpdir(), "runforge-resume-")), repository = join(root, "target"), candidateRepository = join(root, "candidate"), artifactRoot = join(root, "artifacts");
  await mkdir(repository); await writeFile(join(repository, "value.js"), "export default 'bad';\n"); await writeFile(join(repository, "test.js"), "import value from './value.js'; if (value !== 'good') process.exit(1);\n"); await writeFile(join(repository, "package.json"), '{"type":"module"}\n'); await init(repository); const baseSha = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, "value.js"), "export default 'good';\n"); const patch = (await exec("git", ["diff", "--binary", baseSha], { cwd: repository })).stdout; await git(repository, ["reset", "--hard", baseSha]);
  await mkdir(candidateRepository); const binaryPath = join(candidateRepository, "runforge-candidate.js"); await writeFile(binaryPath, "candidate-v2\n"); await chmod(binaryPath, 0o755); await init(candidateRepository); const candidateSourceSha = await git(candidateRepository, ["rev-parse", "HEAD"]), binarySha = sha(await readFile(binaryPath));
  const agreement = { id: "ea_v1_aaaaaaaaaaaaaaaaaaaaaaaa", schemaVersion: 2, profile: "custom", phaseOwnership: [] };
  const immutableSubset = { id: agreement.id, schemaVersion: agreement.schemaVersion, profile: agreement.profile };
  const authoritySnapshot = { allowProviderCalls: true, allowNetwork: false }, validationPlan = { schemaVersion: 1, createdAt: new Date().toISOString(), profile: { id: "test", defaultAcceptance: "required", defaultEvidenceRole: "product-validation", additionalCapabilities: [] }, runtime: { runtime: "local-disposable", lane: "local-disposable-validation", available: ["filesystem", "shell"] }, commands: [{ command, requiredCapabilities: ["filesystem", "shell"], acceptance: "required", evidenceRole: "product-validation", fallbacks: [], source: "explicit", runtime: "local-disposable", lane: "local-disposable-validation", cwd: repository, availableCapabilities: ["filesystem", "shell"], missingCapabilities: [], supported: true, reason: "test", disposition: "execute" }] };
  await persistDurableCheckpoint(artifactRoot, { checkpointId: "checkpoint-0", taskId: "RESUME-TASK-1", projectId: repository, executionAgreementId: agreement.id, sourceRunforgeSha: "a".repeat(40), expectedBaseSha: baseSha, iteration: 0, attempt: 1, generation: "old-generation", kind: "implementation", workspace: { identity: "implementation-workspace", workingDirectory: ".", sha: null, state: "dirty" }, patch, changedFiles: ["value.js"], taskSpec: { taskId: "RESUME-TASK-1", target: { repository, workingDirectory: ".", expectedSha: baseSha } }, executionAgreement: immutableSubset, authoritySnapshot, validationPlan, completedEvidence: [], pendingPhases: ["candidate_validation", "independent_review", "publication"], providerUsage: { implementation: { providerCalls: 1 }, repair: null, validation: { providerCalls: 0 }, review: { providerCalls: 0 } }, executor: {}, safetyAssertions: { secretScanPassed: true }, secretScanResult: { status: "passed" }, unresolvedFindings: [] });
  const task: any = { id: "RESUME-TASK-1", artifactRoot, executionAgreement: { ...agreement, agreementId: agreement.id } };
  const request: any = { artifactRoot, projectId: repository, targetRepository: repository, workingDirectory: ".", expectedBaseSha: baseSha, executionAgreementId: agreement.id, authoritySnapshot, candidateBinary: { path: binaryPath, sha256: binarySha, sourceRunforgeSha: candidateSourceSha, minimumCheckpointSchemaVersion: 2, maximumCheckpointSchemaVersion: 2, features: [] }, dependency: { strategy: "no_dependencies" } };
  return { root, artifactRoot, baseSha, context: { task, taskSpec: { target: { repository, workingDirectory: ".", expectedSha: baseSha } }, checkpointId: "checkpoint-0", request } };
}
async function init(path: string): Promise<void> { await git(path, ["init", "-b", "main"]); await git(path, ["add", "."]); await git(path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]); }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout.trim(); }
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function cacheDigest(root: string): Promise<string> { const hash = createHash("sha256"); hash.update("module.js\0f\0"); hash.update(await readFile(join(root, "module.js"))); return hash.digest("hex"); }
