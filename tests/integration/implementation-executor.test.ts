import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";
import { discoverImplementationExecutors } from "../../src/implementation/executor.js";
import { detectPackageValidationCapabilities } from "../../src/implementation/validation-runtime-capabilities.js";
import { executionPhaseOwner } from "../../src/product/execution-agreement.js";
import { startControlPlaneServer as startBaseControlPlaneServer } from "../../src/control-plane/server.js";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import { defaultAuthority } from "../../src/control-plane/contracts.js";
import type { LogCompressionInvoker } from "../../src/implementation/raw-log-compressor.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../fixtures/implementation/simple-js");
const adapter = resolve(here, "../fixtures/implementation/coding-agent-adapter.mjs");
const previousCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND;
const testLogCompressionInvoker: LogCompressionInvoker = async ({ rawDigest }) => ({
  content: JSON.stringify({ schemaVersion: 1, kind: "log-digest", summary: `Compressed ${rawDigest.sources.length} local test log source(s).`, failureClass: "test.validation", diagnostics: ["Consult the referenced local validation artifact."], sources: rawDigest.sources.map(({ redactions: _redactions, ...source }) => source) }),
  model: "test/cheap-log-compressor", requestId: "test-log-compression", tokenUsage: 1, inputTokens: 1, outputTokens: 0, reasoningTokens: 0, costUsd: 0, attempts: 1,
});
const startControlPlaneServer = (options: { port?: number; stateRoot: string }) => {
  const manager = new ControlPlaneManager(new ControlPlaneStore(options.stateRoot), undefined, undefined, { logCompressionInvoker: testLogCompressionInvoker });
  return startBaseControlPlaneServer({ ...options, manager });
};

afterEach(() => { if (previousCommand === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; else process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = previousCommand; });

describe("implementation executor", () => {
  it("preserves approved preset ownership through the shared resolver", () => {
    expect(executionPhaseOwner("assist-only", "localBranch")).toBe("external_session");
    expect(executionPhaseOwner("assist-only", "localCommit")).toBe("external_session");
    expect(executionPhaseOwner("local-ready", "localBranch")).toBe("runforge");
    expect(executionPhaseOwner("local-ready", "localCommit")).toBe("runforge");
  });

  it("discovers a real configured backend and rejects an unavailable backend", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    expect(await discoverImplementationExecutors()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-coding-agent", status: "ready", supports: ["implementation", "repair"], providerCalls: true }), expect.objectContaining({ id: "openrouter-coding-agent", status: "unavailable", limitations: expect.arrayContaining(["openrouter_credentials_unavailable"]) })]));
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
    expect(await discoverImplementationExecutors()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-coding-agent", status: "unavailable" }), expect.objectContaining({ id: "openrouter-coding-agent", status: "unavailable" })]));
  });

  it("detects package-manager and prepared dependency capabilities from runtime evidence", async () => {
    const repo = await mkdtemp(join(tmpdir(), "runforge-package-capabilities-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));
    expect(await detectPackageValidationCapabilities({
      commands: ["corepack pnpm test"], executionRoot: repo, workspaceRoot: repo,
      commandAvailable: async () => false,
    })).toEqual({ packageManager: false, dependencies: false });
    await mkdir(join(repo, "node_modules"));
    expect(await detectPackageValidationCapabilities({
      commands: ["corepack pnpm test"], executionRoot: repo, workspaceRoot: repo,
      commandAvailable: async (command) => command === "corepack",
    })).toEqual({ packageManager: true, dependencies: true });
  });

  it("does not spawn a known package command when prepared dependencies are absent", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository();
    const probeRoot = await mkdtemp(join(tmpdir(), "runforge-package-validation-probe-"));
    const marker = join(probeRoot, "spawned");
    const command = `npm exec -- node -e "require('node:fs').writeFileSync('${marker}', 'spawned')"`;
    const result = await execute(repo, "EXECUTOR-PACKAGE-CAPABILITY-1", "fix add", [command]);
    expect(result).toMatchObject({
      status: "blocked_by_capability",
      validationAggregate: "blocked_by_capability",
      validationPlan: { commands: [{ command, disposition: "capability_unsupported", supported: false, missingCapabilities: expect.arrayContaining(["dependencies"]) }] },
      validation: [{ command, outcome: "capability_unsupported" }],
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("implements, repairs, validates, adds a test, commits locally, and preserves the source checkout", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const beforeStatus = await git(repo, ["status", "--porcelain"]);
    const remote = await mkdtemp(join(tmpdir(), "runforge-implementation-remote-"));
    await git(remote, ["init", "--bare"]); await git(repo, ["remote", "add", "origin", remote]); await git(repo, ["push", "origin", "main"]);
    const remoteBefore = await git(repo, ["ls-remote", "origin"]);
    const result = await execute(repo, "EXECUTOR-SUCCESS-1", "REPAIR_LOOP ADD_TEST fix add", ["node test.js", "node added.test.js", "node lint.js", "node typecheck.js"]);
    expect(result.implementation).toMatchObject({ status: "implemented_and_validated", performed: true, changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), localBranch: "runforge/executor-success-1/standalone-attempt-1", localCommit: expect.any(String), patchPackage: expect.any(String) });
    expect(result.validation).toHaveLength(4);
    expect((result.validation as Array<Record<string, unknown>>).every((item) => item.exitCode === 0 && typeof item.stdout === "string" && typeof item.stderr === "string")).toBe(true);
    expect(result.providerCalls).toHaveLength(4);
    expect(result.providerCalls.filter((call: Record<string, unknown>) => call.purpose === "raw-log-compression")).toEqual([
      expect.objectContaining({ phase: "logCompression", model: "test/cheap-log-compressor", tokenUsage: 1, usageAccounting: "provider" }),
    ]);
    expect(result.providerCalls.filter((call: Record<string, unknown>) => call.purpose === "semantic-review")).toHaveLength(1);
    expect(result.providerCalls).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: "semantic-review", provider: "local-coding-agent", model: null, invocationId: "semantic-review-1", providerCalls: true, networkAuthorized: true, success: true, validatedCheckpointId: "repair-1", timeoutMs: expect.any(Number), deadlineAt: expect.any(String) })]));
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      agreement: { profile: "local-ready", requestedProfile: "local-ready", effectiveProfile: "local-ready", runforgeCompletedPhases: expect.arrayContaining(["implementation", "localValidation", "patchPackage", "localBranch", "localCommit"]), awaitingPhases: expect.arrayContaining([{ phaseId: "remotePush", responsibleParty: "external_session", prerequisites: [] }]) },
      review: { structural: { kind: "structural", status: "passed", evidence: expect.any(Array) }, semantic: { kind: "semantic", status: "completed", performed: true, selectedReviewer: { provider: "local-coding-agent", model: null }, reviewer: { invocationId: "semantic-review-1" }, confidence: "high", limitations: [], findings: [] } },
      handoff: { profile: "local-ready", changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), patch: "implementation.patch", branch: "runforge/executor-success-1/standalone-attempt-1", commit: expect.any(String), findings: [], semanticReview: { status: "completed", performed: true, confidence: "high" } },
      next: { party: "external_session", exactAction: expect.stringContaining("remotePush") },
      implementation: { unresolvedAcceptanceCriteria: [] },
      git: { branch: "runforge/executor-success-1/standalone-attempt-1", commit: expect.any(String) },
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before); expect(await git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
    expect((await git(repo, ["rev-parse", "refs/heads/main"])).trim()).toBe(before.trim());
    expect((await git(repo, ["rev-parse", "refs/heads/runforge/executor-success-1/standalone-attempt-1"])).trim()).toBe(result.git.commit);
    expect(await git(repo, ["ls-remote", "origin"])).toBe(remoteBefore);
    expect(await readFile(String((result.implementation as Record<string, unknown>).patchPackage), "utf8")).toContain("added.test.js");
    expect(result.publication).toMatchObject({ status: "on_hold", performed: false });
  }, 20_000);

  it("returns an assist-only patch without creating an externally owned branch or commit", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const refsBefore = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { execution, result } = await executeWithExecution(
      repo, "EXECUTOR-ASSIST-ONLY-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "assist-only" },
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      implementation: { status: "implemented_and_validated", localBranch: null, localCommit: null, patchPackage: expect.any(String) },
      git: { branch: null, commit: null, patchPackage: expect.any(String) },
      agreement: { profile: "assist-only", requestedProfile: "assist-only", effectiveProfile: "assist-only" },
      handoff: { profile: "assist-only", patch: "implementation.patch", branch: null, commit: null },
      next: { party: "external_session" },
      review: { structural: { kind: "structural", status: "passed" }, semantic: { kind: "semantic", status: "forbidden", performed: false, selectedReviewer: { provider: null, model: null }, confidence: "unknown", findings: [], delegation: { party: "external_session" } } },
    });
    expect(result.providerCalls.filter((call: Record<string, unknown>) => call.purpose === "semantic-review")).toHaveLength(0);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
    expect(await readFile(String(result.implementation.patchPackage), "utf8")).toContain("diff --git");
  });

  it("preserves completed RunForge scope and delegates when the semantic reviewer is unavailable", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository();
    const result = await execute(repo, "EXECUTOR-SEMANTIC-UNAVAILABLE-1", "SEMANTIC_UNAVAILABLE fix add", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_owner",
      implementation: { status: "blocked_with_owner_gate", performed: true },
      review: { structural: { kind: "structural", status: "passed" }, semantic: { kind: "semantic", status: "unavailable", performed: false, selectedReviewer: { provider: "local-coding-agent", model: null }, confidence: "unknown", limitations: [expect.stringContaining("semantic_review_required")], findings: [], delegation: { party: "owner" } } },
      handoff: { semanticReview: { status: "unavailable", performed: false, delegation: { party: "owner" } } },
      handoffPackage: { semanticReview: { status: "unavailable" }, nextResponsibleParty: "owner" },
      agreement: { runforgeCompletedPhases: [], awaitingPhases: expect.arrayContaining([expect.objectContaining({ phaseId: "independentReview", responsibleParty: "owner" })]) },
    });
  });

  it("passes complete review context after a validated checkpoint exists", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository();
    const result = await execute(repo, "EXECUTOR-SEMANTIC-CONTEXT-1", "SEMANTIC_CONTEXT fix add", ["node test.js"]);
    expect(result).toMatchObject({
      implementation: { status: "implemented_and_validated" },
      artifact: { bestValidatedCheckpointId: "implementation-0" },
      review: { semantic: { status: "completed", performed: true, confidence: "high" } },
      providerCalls: expect.arrayContaining([expect.objectContaining({ purpose: "semantic-review", validatedCheckpointId: "implementation-0" })]),
    });
  });

  it("times out only the semantic review phase and preserves completed RunForge scope plus its validated checkpoint", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository();
    const result = await execute(repo, "EXECUTOR-SEMANTIC-TIMEOUT-1", "SEMANTIC_TIMEOUT fix add", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_owner",
      implementation: { status: "blocked_with_owner_gate", performed: true },
      artifact: { status: "available", bestValidatedCheckpointId: "implementation-0", checkpoints: [expect.objectContaining({ id: "implementation-0", validationPassed: true })] },
      review: { structural: { status: "passed" }, semantic: { status: "unavailable", performed: false, limitations: [expect.stringContaining("timed out")], delegation: { party: "owner" } } },
      handoffPackage: { bestValidatedCheckpoint: "implementation-0", latestSafePatch: expect.stringContaining("implementation-0"), semanticReview: { status: "unavailable", performed: false }, nextResponsibleParty: "owner" },
      agreement: { runforgeCompletedPhases: [], awaitingPhases: expect.arrayContaining([expect.objectContaining({ phaseId: "independentReview", responsibleParty: "owner" })]) },
      providerCalls: expect.arrayContaining([expect.objectContaining({ purpose: "semantic-review", provider: "local-coding-agent", model: null, success: false, timedOut: true, timeoutMs: expect.any(Number), validatedCheckpointId: "implementation-0" })]),
    });
    const reviewCall = result.providerCalls.find((call: Record<string, unknown>) => call.purpose === "semantic-review");
    expect(reviewCall.timeoutMs).toBeLessThan(1_000);
  }, 10_000);

  it("propagates blocking structured semantic findings into the result and portable handoff", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository();
    const result = await execute(repo, "EXECUTOR-SEMANTIC-FINDING-1", "SEMANTIC_FINDING fix add", ["node test.js"]);
    const finding = { severity: "high", file: "calculator.js", location: "1:1", category: "correctness", blocking: true };
    expect(result).toMatchObject({
      status: "awaiting_owner",
      implementation: { status: "blocked_with_owner_gate", performed: true }, ownerGate: { required: true },
      review: { structural: { kind: "structural", status: "passed" }, semantic: { status: "completed", performed: true, confidence: "high", findings: [finding] } },
      handoff: { findings: expect.arrayContaining([expect.objectContaining(finding)]), semanticReview: { status: "completed", performed: true, confidence: "high", findings: [finding] } },
      handoffPackage: { findings: expect.arrayContaining([expect.objectContaining(finding)]), semanticReview: { status: "completed", performed: true, confidence: "high", findings: [finding] } },
    });
  });

  it.each([["external_session", "implementation"], ["external_system", "repair"]] as const)("hands %s-owned implementation off in %s mode without invoking the configured coding adapter", async (party, mode) => {
    const repo = await repository();
    const probeRoot = await mkdtemp(join(tmpdir(), "runforge-delegated-adapter-probe-"));
    const marker = join(probeRoot, "invoked");
    const probe = join(probeRoot, "adapter.mjs");
    await writeFile(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "invoked"); throw new Error("delegated adapter must not run");\n`);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${probe}`;
    const before = {
      head: await git(repo, ["rev-parse", "HEAD"]),
      status: await git(repo, ["status", "--porcelain=v1", "-uall"]),
      refs: await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    };
    const { execution, result } = await executeWithExecution(
      repo, `EXECUTOR-DELEGATED-${party === "external_session" ? "SESSION" : "SYSTEM"}-1`, "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: party, localBranch: party, localCommit: party, providerModelCalls: party } },
      undefined, mode,
    );
    expect(execution).toMatchObject({ kind: "implementation", success: true, result: { status: "delegated", responsibleParty: party, selectedExecutor: { id: "agreement-handoff" }, providerCalls: [], publicationMutations: 0 } });
    expect(result).toMatchObject({
      status: party === "external_session" ? "awaiting_external_session" : "runforge_scope_completed",
      actualExecutorMode: "agreement-handoff",
      selectedExecutor: { id: "agreement-handoff", model: null },
      implementation: { status: "delegated", performed: false, responsibleParty: party, changedFiles: [], localBranch: null, localCommit: null },
      targetRepository: { initialSha: before.head.trim(), finalSha: before.head.trim(), changed: false, refsChanged: false },
      providerCalls: [], providerMutations: 0, publicationMutations: 0,
      publication: { performed: false, mutations: 0 },
      agreement: { profile: "custom", requestedProfile: "custom", effectiveProfile: "custom" },
      handoff: { profile: "assist-only", branch: null, commit: null },
      next: { party, exactAction: `Complete the delegated implementation phase in ${party} and attach its completion evidence.` },
      safetyAssertions: { targetUnchanged: true, providerCalls: false },
    });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await git(repo, ["status", "--porcelain=v1", "-uall"])).toBe(before.status);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.refs);
  });

  it("isolates deterministic RunForge branches across retry attempts and refuses only an exact attempt collision", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const statusBefore = await git(repo, ["status", "--porcelain"]);
    const first = await executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-a", "implementation", 1);
    const retry = await executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-b", "implementation", 2);
    expect(first.result.git.branch).toBe("runforge/executor-retry-branch-1/generation-a-attempt-1");
    expect(retry.result.git.branch).toBe("runforge/executor-retry-branch-1/generation-b-attempt-2");
    expect(retry.result.git.branch).not.toBe(first.result.git.branch);
    await expect(executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-b", "implementation", 2)).rejects.toThrow("local_branch_collision");
    expect((await git(repo, ["rev-parse", `refs/heads/${first.result.git.branch}`])).trim()).toBe(first.result.git.commit);
    expect((await git(repo, ["rev-parse", `refs/heads/${retry.result.git.branch}`])).trim()).toBe(retry.result.git.commit);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
  });

  it("creates a detached local commit without creating a RunForge-owned branch when only localCommit is owned", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const statusBefore = await git(repo, ["status", "--porcelain"]); const refsBefore = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { execution, result } = await executeWithExecution(repo, "EXECUTOR-COMMIT-ONLY-1", "fix add", ["node test.js"], [], {
      schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", patchPackage: "runforge", localBranch: "external_session", localCommit: "runforge" },
    }, "commit-only-generation", "implementation", 1);
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      implementation: { localBranch: null, localCommit: expect.any(String) },
      git: { branch: null, commit: expect.any(String) },
      workflow: {
        status: "awaiting_external_session",
        handoff: { profile: "assist-only", branch: null, commit: expect.any(String) },
        agreement: { runforgeCompletedPhases: expect.arrayContaining(["localCommit"]), awaitingPhases: expect.arrayContaining([{ phaseId: "localBranch", responsibleParty: "external_session", prerequisites: [] }]) },
      },
    });
    expect(await git(repo, ["cat-file", "-t", result.git.commit])).toBe("commit\n");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
  });

  it.each([
    ["external_session", "awaiting_external_session"],
    ["external_system", "runforge_scope_completed"],
  ] as const)("settles successfully while an %s implementation workflow phase remains delegated", async (party, completionStatus) => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const { execution, result } = await executeWithExecution(
      await repository(), "EXECUTOR-EXTERNAL-HANDOFF-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", independentReview: party } },
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: completionStatus,
      agreement: {
        runforgeCompletedPhases: ["implementation", "localValidation"],
        awaitingPhases: [{ phaseId: "independentReview", responsibleParty: party, prerequisites: [] }],
      },
      handoff: { profile: "assist-only", findings: [], nextActions: [{ party, exactAction: expect.stringContaining("independentReview") }] },
      next: { party, exactAction: expect.stringContaining("independentReview") },
    });
  });

  it("keeps control-plane settlement successful while preserving agreement-aware workflow semantics", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const { execution, result } = await executeWithExecution(
      await repository(), "EXECUTOR-CONTROL-SETTLEMENT-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", independentReview: "external_session" } },
      "control-plane-execution",
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      workflow: {
        status: "awaiting_external_session",
        agreement: { awaitingPhases: [{ phaseId: "independentReview", responsibleParty: "external_session", prerequisites: [] }] },
        handoff: { profile: "assist-only", findings: [], nextActions: [{ party: "external_session" }] },
      },
    });
  });

  it.each([
    ["FALSE_POSITIVE", "no_change_required", "awaiting_external_session"],
    ["AMBIGUOUS_CHANGE", "blocked_with_owner_gate", "awaiting_owner"],
    ["FORBIDDEN_CHANGE", "blocked_with_owner_gate", "awaiting_owner"]
  ])("returns explicit outcome for %s", async (task, outcome, status) => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(), `EXECUTOR-${task}-1`, task, ["node test.js"], task === "FORBIDDEN_CHANGE" ? ["secrets.txt"] : []);
    expect(result.status).toBe(status); expect(result.implementation).toMatchObject({ status: outcome });
  });

  it("ignores credential-like assignments that appear only as unchanged patch context", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(true), "EXECUTOR-SECRET-CONTEXT-1", "fix add", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      implementation: { status: "implemented_and_validated", localCommit: expect.any(String) },
      safetyAssertions: { secretScanPassed: true },
    });
  });

  it("snapshots from the accepted SHA while distinguishing user dirt from known RunForge telemetry", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const snapshotRepo = await repository(); await writeFile(join(snapshotRepo, "human-notes.txt"), "preserve me\n"); const before = await git(snapshotRepo, ["status", "--porcelain=v1"]);
    const snapshot = await executeWithExecution(snapshotRepo, "EXECUTOR-DIRTY-SNAPSHOT-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" });
    expect(snapshot.result).toMatchObject({ implementation: { status: "implemented_and_validated" }, diagnostics: { dirtyPolicy: "use_disposable_from_base_sha" }, safetyAssertions: { sourceWorktreeStateUnchanged: true } }); expect(await git(snapshotRepo, ["status", "--porcelain=v1"])).toBe(before);
    const strictRepo = await repository(); await writeFile(join(strictRepo, "human-notes.txt"), "preserve me\n"); await expect(executeWithExecution(strictRepo, "EXECUTOR-DIRTY-STRICT-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, undefined, "implementation", undefined, "require_clean")).rejects.toThrow("active_human_work_conflict");
    const telemetryRepo = await repository(); await import("node:fs/promises").then(({ mkdir }) => mkdir(join(telemetryRepo, ".runforge"))); await writeFile(join(telemetryRepo, ".runforge", "trace.log"), "task-owned\n");
    await expect(executeWithExecution(telemetryRepo, "EXECUTOR-DIRTY-TELEMETRY-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, undefined, "implementation", undefined, "allow_known_generated")).resolves.toMatchObject({ result: { implementation: { status: "implemented_and_validated" } } });
  });

  it("rejects a credential-like assignment newly added by the implementation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-secret-agent-")); const agent = join(root, "agent.mjs");
    await writeFile(agent, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", ["\\n// API", "_KEY=", "newlyaddedvalue", "\\n"].join(""));`,
      `console.log("implemented bounded change");`,
      `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } }));`,
    ].join("\n"));
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    const result = await execute(await repository(), "EXECUTOR-SECRET-ADDITION-1", "add rejected fixture line", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_owner",
      implementation: { status: "blocked_with_owner_gate", localCommit: null },
      safetyAssertions: { secretScanPassed: false },
    });
  });

  it("marks empty non-zero validation output as an infrastructure defect", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(), "EXECUTOR-EMPTY-DIAGNOSTIC-1", "fix add", ["node -e \"process.exit(1)\""]);
    expect(result).toMatchObject({ status: "failed", implementation: { status: "failed_with_diagnostics" } });
    expect(result.validation).toMatchObject([{ exitCode: 1, stdout: "", stderr: "", infrastructureDefect: "non-zero exit produced empty stdout and stderr" }]);
  });

  it("runs end-to-end through localhost HTTP with visible selection and publication separation", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-control-"));
    const sourceHeadBefore = await git(repo, ["rev-parse", "HEAD"]); const sourceStatusBefore = await git(repo, ["status", "--porcelain"]);
    const remote = await mkdtemp(join(tmpdir(), "runforge-implementation-http-remote-"));
    await git(remote, ["init", "--bare"]); await git(repo, ["remote", "add", "origin", remote]); await git(repo, ["push", "origin", "main"]);
    const remoteBefore = await git(repo, ["ls-remote", "origin"]);
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      expect(capabilities.implementationExecutors).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-coding-agent", status: "ready" }), expect.objectContaining({ id: "openrouter-coding-agent", status: "unavailable" })]));
      expect(capabilities.implementationExecutors[0].command).toBeUndefined();
      expect(capabilities.taskSpecContract).toMatchObject({ contractVersion: "task-spec-v2", schemaVersion: 2, schemaUrl: "/schemas/task-spec-v2.schema.json", schema: { required: expect.arrayContaining(["execution"]) }, runtimeDefaults: { implementation: "local-disposable" }, implementationRequest: { taskSpec: { execution: { mode: "implementation", maxProviderTokens: 200000 }, runtime: { preference: "local-disposable" } }, authority: { localBranch: true, localCommit: true } } });
      expect(capabilities.taskSpecContract.implementationRequest.taskSpec.execution.maxProviderTokens).toBe(capabilities.implementationExecutors[0].maxLimits.providerTokens);
      const discovery = await fetch(`${server.url}/.well-known/runforge`).then((response) => response.json()) as Record<string, any>;
      expect(discovery.taskSpecContract).toMatchObject({ implementationExecutorIds: ["local-coding-agent"], compatibleRuntimes: { "local-coding-agent": ["local-disposable"] }, implementationRequest: { taskSpec: { runtime: { preference: "local-disposable" } } } });
      const schemaResponse = await fetch(`${server.url}${discovery.endpoints.taskSpecSchema}`); expect(schemaResponse.status).toBe(200);
      const schema = await schemaResponse.json() as Record<string, any>; expect(schema).toMatchObject({ title: "RunForge TaskSpec v2", required: expect.arrayContaining(["execution"]), properties: { runtime: { properties: { preference: { enum: ["docker", "local-disposable"] } } } } });
      expect(schema).toEqual(JSON.parse(await readFile(resolve(here, "../../schemas/task-spec-v2.schema.json"), "utf8")));
      const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(schema); expect(validate(discovery.taskSpecContract.implementationRequest.taskSpec), validate.errors?.map((item: { instancePath: string; message?: string }) => `${item.instancePath} ${item.message}`).join("; ")).toBe(true);
      const ready = await fetch(`${server.url}/readyz`).then((response) => response.json()) as Record<string, any>;
      expect(ready.implementationExecutors).toMatchObject(discovery.implementationExecutors.map((item: Record<string, unknown>) => ({ id: item.id, status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime, maxLimits: item.maxLimits, model: item.model, credentialReady: item.credentialReady })));
      expect(discovery.implementationExecutors).toEqual(capabilities.implementationExecutors);
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true, runtime: "local" }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(discovery.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-HTTP-1"; request.taskSpec.task.text = "ADD_TEST fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js", "node added.test.js"] };
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(created.status).toBe(202);
      const accepted = await created.json() as Record<string, any>; expect(accepted.selection).toMatchObject({ requestedMode: "implementation", normalizedMode: "implementation", selectedExecutor: "local-coding-agent", selectedRuntime: "local-disposable", authorityChecks: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true }, providerDecision: "allowed", networkDecision: "allowed" });
      const terminal = await poll(`${server.url}/v1/tasks/EXECUTOR-HTTP-1`); expect(terminal.status).toBe("completed");
      expect(terminal.events.map((item: any) => item.detail).join(" ")).toContain("implement:");
      const result = await fetch(`${server.url}/v1/tasks/EXECUTOR-HTTP-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(result).toMatchObject({
        status: "completed",
        workflow: {
          status: "awaiting_external_session",
          agreement: { profile: "local-ready", requestedProfile: "local-ready", effectiveProfile: "local-ready", runforgeCompletedPhases: expect.arrayContaining(["implementation", "localValidation", "patchPackage", "localBranch", "localCommit"]) },
          handoff: { profile: "local-ready", findings: [], branch: expect.stringMatching(/^runforge\/executor-http-1\/[a-z0-9-]+-attempt-1$/), commit: expect.any(String) },
          next: { party: "external_session", exactAction: expect.stringContaining("remotePush") },
        },
        requestedIntent: "implementation", actualExecutorMode: "implementation",
        implementation: { status: "implemented_and_validated", unresolvedAcceptanceCriteria: [] },
        publication: { status: "on_hold", performed: false },
      });
      expect(result.workflow.agreement.awaitingPhases).toEqual(expect.arrayContaining([
        expect.objectContaining({ phaseId: "remotePush", responsibleParty: "external_session" }),
      ]));
      expect(result).toMatchObject({
        implementation: { localBranch: result.workflow.handoff.branch, localCommit: expect.any(String) },
        git: { branch: result.workflow.handoff.branch, commit: expect.any(String) },
      });
      const persisted = JSON.parse(await readFile(join(state, "tasks", "EXECUTOR-HTTP-1", "result.json"), "utf8")) as Record<string, any>;
      expect(persisted.result.workflow.handoff.branch).toBe(result.workflow.handoff.branch);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
      expect(await git(repo, ["status", "--porcelain"])).toBe(sourceStatusBefore);
      expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
      expect(await git(repo, ["ls-remote", "origin"])).toBe(remoteBefore);
    } finally { await server.close(); }
  }, 20_000);

  it("preserves a green implementation across post-implementation overrun and accepts it idempotently without provider rerun", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const state = await mkdtemp(join(tmpdir(), "runforge-durable-overrun-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(capabilities.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-DURABLE-OVERRUN-1"; request.taskSpec.task.text = "BUDGET_OVERRUN fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js"] }; request.taskSpec.execution.phaseBudgets.implementation = 1_000;
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }); expect(created.status).toBe(202);
      const acceptedTask = await created.json() as Record<string, any>; expect(acceptedTask.timeout).toMatchObject({ requestedMs: 300000, effectiveMs: 300000, limitingSource: "requested" });
      const terminal = await poll(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1`); expect(terminal.status).toBe("awaiting_owner_decision");
      const result = await fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(result).toMatchObject({ implementation: { status: "blocked_with_owner_gate" }, artifact: { status: "available", bestValidatedCheckpointId: "implementation-0" }, workflow: { status: "awaiting_owner", budgetExceeded: true }, usage: { accounting: "provider", totalTokens: 120000, costUsd: null, syntheticAccounting: { mixedWithProviderUsage: false } }, ownerGate: { required: true, options: expect.arrayContaining([expect.objectContaining({ id: "accept_completed_patch", providerRun: false })]) }, handoffPackage: { status: "available", bestValidatedCheckpoint: "implementation-0" } });
      expect(await readFile(join(state, "tasks", "EXECUTOR-DURABLE-OVERRUN-1", "attempts", "1", "artifacts", result.artifact.checkpoints[0].patchPath), "utf8")).toContain("diff --git");
      const implicitDiscard = await fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/discard-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkpointId: "implementation-0" }) }); expect(implicitDiscard.status).toBe(400);
      const body = JSON.stringify({ decisionId: "accept-overrun-1", checkpointId: "implementation-0", delivery: "patch" });
      const [first, replay] = await Promise.all([fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/accept-completed-result`, { method: "POST", headers: { "content-type": "application/json" }, body }), fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/accept-completed-result`, { method: "POST", headers: { "content-type": "application/json" }, body })]);
      expect(first.status).toBe(200); expect(replay.status).toBe(200); const responses = [await first.json(), await replay.json()] as Record<string, any>[]; expect(responses).toEqual(expect.arrayContaining([expect.objectContaining({ status: "accepted", patch: expect.stringContaining("diff --git"), providerCalls: 0, providerRerun: false, targetMainMutation: false }), expect.objectContaining({ idempotentReplay: true, providerCalls: 0 })]));
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    } finally { await server.close(); }
  }, 20_000);

  it("starts an idempotent bounded repair generation from a digest-bound failed checkpoint", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const mainBefore = await git(repo, ["rev-parse", "refs/heads/main"]); const state = await mkdtemp(join(tmpdir(), "runforge-checkpoint-repair-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      expect(capabilities.checkpointRepair).toMatchObject({ choices: ["grant_additional_budget", "retry_from_checkpoint"], requiresCheckpointDigest: true });
      const discovery = await fetch(`${server.url}/.well-known/runforge`).then((response) => response.json()) as Record<string, any>; expect(discovery.endpoints.checkpointRepairs).toBe("/v1/tasks/{id}/checkpoint-repairs");
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(capabilities.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-CHECKPOINT-REPAIR-1"; request.taskSpec.task.text = "BUDGET_OVERRUN REPAIR_LOOP fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js"] }; request.taskSpec.execution.phaseBudgets.implementation = 1_000;
      expect((await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).status).toBe(202);
      await poll(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1`);
      const failed = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/result`).then((response) => response.json()) as Record<string, any>;
      const checkpoint = failed.artifact.checkpoints[0]; expect(checkpoint).toMatchObject({ id: "implementation-0", validationPassed: false, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const directAccept = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/accept-completed-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "invalid-direct-accept", checkpointId: checkpoint.id, delivery: "patch" }) }); expect(directAccept.status).toBe(409); expect(await directAccept.json()).toMatchObject({ error: { code: "checkpoint_not_validated" } });
      const wrongTask = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "OTHER-TASK", decisionId: "wrong-task", checkpointId: checkpoint.id, checkpointDigest: checkpoint.digest, choice: "retry_from_checkpoint", repairIntent: "Repair only the recorded validation failure." }) }); expect(wrongTask.status).toBe(409); expect(await wrongTask.json()).toMatchObject({ error: { code: "wrong_task_checkpoint" } });
      const invalidDigest = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "EXECUTOR-CHECKPOINT-REPAIR-1", decisionId: "wrong-digest", checkpointId: checkpoint.id, checkpointDigest: "0".repeat(64), choice: "retry_from_checkpoint", repairIntent: "Repair only the recorded validation failure." }) }); expect(invalidDigest.status).toBe(409); expect(await invalidDigest.json()).toMatchObject({ error: { code: "checkpoint_digest_invalid" } });
      const repairBody = JSON.stringify({ taskId: "EXECUTOR-CHECKPOINT-REPAIR-1", decisionId: "repair-decision-1", checkpointId: checkpoint.id, checkpointDigest: checkpoint.digest, choice: "retry_from_checkpoint", repairIntent: "Repair only the recorded validation failure." });
      const started = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: repairBody }); expect(started.status).toBe(202); const startResult = await started.json() as Record<string, any>; expect(startResult).toMatchObject({ status: "repair_generation_started", authorityGranted: false, baseSha: mainBefore.trim(), checkpointDigest: checkpoint.digest, providerRun: true, targetMainMutation: false, patchFallback: expect.stringMatching(/attempts\/1\/artifacts\/checkpoints\/implementation-0\/[a-f0-9]{64}\/patch\.diff$/), repairExecutionId: expect.any(String) });
      const replay = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: repairBody }); expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ idempotentReplay: true, repairExecutionId: startResult.repairExecutionId });
      const repairedTask = await poll(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1`); expect(repairedTask.status).toBe("completed"); expect(repairedTask.execution.attempt).toBe(2);
      const repaired = await fetch(`${server.url}/v1/tasks/EXECUTOR-CHECKPOINT-REPAIR-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(repaired).toMatchObject({ implementation: { status: "implemented_and_validated" }, artifact: { checkpoints: [expect.objectContaining({ id: "repair-1", validationPassed: true, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })] }, safetyAssertions: { targetMainMutation: false } });
      expect(await git(repo, ["rev-parse", "refs/heads/main"])).toBe(mainBefore);
    } finally { await server.close(); }
  }, 20_000);

  it("repairs a persisted schema-v1 checkpoint through a restarted manager", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const taskId = "LEGACY-MANAGER-REPAIR-1"; const repo = await repository(); const head = await git(repo, ["rev-parse", "HEAD"]); const state = await mkdtemp(join(tmpdir(), "runforge-legacy-manager-"));
    let manager = new ControlPlaneManager(new ControlPlaneStore(state), undefined, undefined, { logCompressionInvoker: testLogCompressionInvoker }); await manager.initialize();
    const value: Record<string, any> = spec(repo, taskId, "BUDGET_OVERRUN REPAIR_LOOP fix add", ["node test.js"]); value.execution.phaseBudgets = { implementation: 1_000, repair: 50_000 };
    await manager.createTask({ taskSpec: value, authority: defaultAuthority({ implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true }), publicationRequested: "none" });
    expect((await pollManager(manager, taskId)).status).toBe("awaiting_owner_decision");
    const v2Checkpoint = objectValue((await manager.getResult(taskId)).artifact).checkpoints[0]; await expect(manager.repairFromCheckpoint(taskId, { taskId, decisionId: "v2-strict-digest", checkpointId: v2Checkpoint.id, checkpointDigest: "0".repeat(64), choice: "retry_from_checkpoint", additionalProviderTokens: 0, repairIntent: "Verify strict schema-v2 digest binding." })).rejects.toMatchObject({ code: "checkpoint_digest_invalid" }); manager.close();
    const legacy = await downgradeCheckpointToLegacy(state, taskId, "implementation-0"); const before = await directorySnapshot(legacy.checkpointPath);
    manager = new ControlPlaneManager(new ControlPlaneStore(state), undefined, undefined, { logCompressionInvoker: testLogCompressionInvoker }); await manager.initialize();
    const result = await manager.getResult(taskId); const checkpoint = objectValue(result.artifact).checkpoints[0]; expect(checkpoint).toMatchObject({ checkpointSchemaVersion: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const repairRequest = (decisionId: string, checkpointDigest: string) => ({ taskId, decisionId, checkpointId: checkpoint.id, checkpointDigest, choice: "retry_from_checkpoint" as const, additionalProviderTokens: 0, repairIntent: "Repair only the recorded validation failure." });
    await writeFile(join(legacy.checkpointPath, "patch.diff"), "corrupt\n"); await expect(manager.repairFromCheckpoint(taskId, repairRequest("corrupt", checkpoint.digest))).rejects.toMatchObject({ code: "checkpoint_digest_invalid" }); await restoreDirectory(legacy.checkpointPath, before);
    const unsafeDigest = await rewriteLegacyPayload(legacy.checkpointPath, "safety.json", { ...(JSON.parse(await readFile(join(legacy.checkpointPath, "safety.json"), "utf8")) as Record<string, unknown>), secretScanPassed: false }); await expect(manager.repairFromCheckpoint(taskId, repairRequest("unsafe", unsafeDigest))).rejects.toMatchObject({ code: "unsafe_checkpoint" }); await restoreDirectory(legacy.checkpointPath, before);
    const executor = JSON.parse(await readFile(join(legacy.checkpointPath, "executor.json"), "utf8")) as Record<string, unknown>; const copiedDigest = await rewriteLegacyPayload(legacy.checkpointPath, "executor.json", { ...executor, generation: "00000000-0000-4000-8000-000000000000" }); await expect(manager.repairFromCheckpoint(taskId, repairRequest("copied", copiedDigest))).rejects.toMatchObject({ code: "checkpoint_generation_mismatch" }); await restoreDirectory(legacy.checkpointPath, before);
    await writeFile(legacy.manifestPath, JSON.stringify({ ...legacy.manifest, baseSha: "0".repeat(40) }, null, 2) + "\n"); await expect(manager.repairFromCheckpoint(taskId, repairRequest("stale", digestFile(await readFile(legacy.manifestPath))))).rejects.toMatchObject({ code: "stale_checkpoint" }); await restoreDirectory(legacy.checkpointPath, before);
    const request = repairRequest("legacy-manager-repair", checkpoint.digest);
    const started = await manager.repairFromCheckpoint(taskId, request); const replay = await manager.repairFromCheckpoint(taskId, request); expect(replay).toMatchObject({ idempotentReplay: true, repairExecutionId: started.repairExecutionId });
    expect((await pollManager(manager, taskId)).status).toBe("completed"); expect(await directorySnapshot(legacy.checkpointPath)).toEqual(before); expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head); manager.close();
  }, 20_000);

  it("upgrades, discovers, and safely repairs the preserved schema-v1 W1 checkpoint without mutating source or legacy artifacts", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const taskId = "RUNFORGE-VALIDATION-CAPABILITIES-1-W1";
    const repo = await repository(); const sourceBefore = { head: await git(repo, ["rev-parse", "HEAD"]), status: await git(repo, ["status", "--porcelain=v1", "-uall"]) };
    const state = await mkdtemp(join(tmpdir(), "runforge-legacy-checkpoint-upgrade-"));
    let server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(capabilities.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = taskId; request.taskSpec.task.text = "BUDGET_OVERRUN REPAIR_LOOP fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js"] }; request.taskSpec.execution.phaseBudgets.implementation = 1_000;
      expect((await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).status).toBe(202);
      expect((await poll(`${server.url}/v1/tasks/${taskId}`)).status).toBe("awaiting_owner_decision");
    } finally { await server.close(); }

    const legacy = await downgradeCheckpointToLegacy(state, taskId, "implementation-0");
    const immutableLegacy = await directorySnapshot(legacy.checkpointPath);
    server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      expect(capabilities.checkpointRepair).toMatchObject({ requiresCheckpointDigest: true, digestDiscovery: expect.stringContaining("artifact.checkpoints[].digest"), legacySchemaV1: "verified-on-read", immutableLegacyArtifactsRewritten: false });
      const upgraded = await fetch(`${server.url}/v1/tasks/${taskId}/result`).then((response) => response.json()) as Record<string, any>;
      const discovered = upgraded.artifact.checkpoints[0];
      expect(discovered).toMatchObject({ id: "implementation-0", digest: expect.stringMatching(/^[a-f0-9]{64}$/), checkpointSchemaVersion: 1, digestSource: "verified_immutable_manifest" });
      expect(upgraded.checkpointRepairContract).toMatchObject({ legacySchemaV1DigestsVerifiedOnRead: true, immutableArtifactsRewritten: false });
      expect(JSON.parse(await readFile(legacy.manifestPath, "utf8"))).not.toHaveProperty("taskId");

      const postRepair = (decisionId: string, digest: string, repairIntent = "Repair only the recorded validation failure.") => fetch(`${server.url}/v1/tasks/${taskId}/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId, decisionId, checkpointId: "implementation-0", checkpointDigest: digest, choice: "retry_from_checkpoint", repairIntent }) });
      await writeFile(legacy.manifestPath, JSON.stringify({ ...legacy.manifest, baseSha: "0".repeat(40) }, null, 2) + "\n");
      const stale = await postRepair("legacy-stale", digestFile(await readFile(legacy.manifestPath))); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: "stale_checkpoint" } });
      await restoreDirectory(legacy.checkpointPath, immutableLegacy);

      await writeFile(join(legacy.checkpointPath, "patch.diff"), Buffer.concat([await readFile(join(legacy.checkpointPath, "patch.diff")), Buffer.from("\ncorrupt\n")]));
      const corrupt = await postRepair("legacy-corrupt", discovered.digest); expect(corrupt.status).toBe(409); expect(await corrupt.json()).toMatchObject({ error: { code: "checkpoint_digest_invalid" } });
      await restoreDirectory(legacy.checkpointPath, immutableLegacy);

      const unsafeDigest = await rewriteLegacyPayload(legacy.checkpointPath, "safety.json", { ...(JSON.parse((await readFile(join(legacy.checkpointPath, "safety.json"))).toString()) as Record<string, unknown>), secretScanPassed: false });
      const unsafe = await postRepair("legacy-unsafe", unsafeDigest); expect(unsafe.status).toBe(409); expect(await unsafe.json()).toMatchObject({ error: { code: "unsafe_checkpoint" } });
      await restoreDirectory(legacy.checkpointPath, immutableLegacy);

      const executor = JSON.parse(await readFile(join(legacy.checkpointPath, "executor.json"), "utf8")) as Record<string, unknown>;
      const copiedDigest = await rewriteLegacyPayload(legacy.checkpointPath, "executor.json", { ...executor, generation: "00000000-0000-4000-8000-000000000000" });
      const copied = await postRepair("legacy-copied", copiedDigest); expect(copied.status).toBe(409); expect(await copied.json()).toMatchObject({ error: { code: "checkpoint_generation_mismatch" } });
      await restoreDirectory(legacy.checkpointPath, immutableLegacy);

      const repairBody = JSON.stringify({ taskId, decisionId: "legacy-repair", checkpointId: "implementation-0", checkpointDigest: discovered.digest, choice: "retry_from_checkpoint", repairIntent: "Repair only the recorded validation failure." });
      const [first, racedReplay] = await Promise.all([fetch(`${server.url}/v1/tasks/${taskId}/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: repairBody }), fetch(`${server.url}/v1/tasks/${taskId}/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: repairBody })]);
      expect(first.status).toBe(202); expect(racedReplay.status).toBe(202);
      const starts = [await first.json(), await racedReplay.json()] as Record<string, any>[];
      expect(starts[0].repairExecutionId).toBe(starts[1].repairExecutionId); expect(starts.some((item) => item.idempotentReplay === true)).toBe(true);
      const conflict = await postRepair("legacy-repair", discovered.digest, "A different repair scope."); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
      const repairedTask = await poll(`${server.url}/v1/tasks/${taskId}`); expect(repairedTask).toMatchObject({ status: "completed", execution: { attempt: 2 } });
      const repaired = await fetch(`${server.url}/v1/tasks/${taskId}/result`).then((response) => response.json()) as Record<string, any>;
      expect(repaired).toMatchObject({ implementation: { status: "implemented_and_validated" }, artifact: { checkpoints: [expect.objectContaining({ id: "repair-1", digest: expect.stringMatching(/^[a-f0-9]{64}$/) })] }, safetyAssertions: { targetMainMutation: false } });
    } finally { await server.close(); }

    server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const replay = await fetch(`${server.url}/v1/tasks/${taskId}/checkpoint-repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId, decisionId: "legacy-repair", checkpointId: "implementation-0", checkpointDigest: digestFile(immutableLegacy["manifest.json"]!), choice: "retry_from_checkpoint", repairIntent: "Repair only the recorded validation failure." }) });
      expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ idempotentReplay: true, checkpointSchemaVersion: 1, repairExecutionId: expect.any(String) });
      expect(await directorySnapshot(legacy.checkpointPath)).toEqual(immutableLegacy);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sourceBefore.head); expect(await git(repo, ["status", "--porcelain=v1", "-uall"])).toBe(sourceBefore.status);
    } finally { await server.close(); }
  }, 30_000);

  it("blocks provider denial and unavailable executors before accepting implementation work", async () => {
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-preflight-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
      const denied = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-DENIED-1", "fix", ["node test.js"]), authority: { implementation: true, localBranch: true, localCommit: true } }) });
      expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { code: "provider_authority_denied" } });
      const explicitAgreement = await server.manager.negotiateAgreement({ schemaVersion: 1, profile: "assist-only" });
      const agreementsBeforeRejection = await directorySnapshot(join(state, "execution-agreements"));
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
      const unavailable = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-UNAVAILABLE-1", "fix", ["node test.js"]), authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ error: { code: "implementation_executor_unavailable" } });
      expect((await server.manager.store.listTasks()).map((item) => item.id)).not.toContain("EXECUTOR-UNAVAILABLE-1");
      expect(await directorySnapshot(join(state, "execution-agreements"))).toEqual(agreementsBeforeRejection);
      expect(await server.manager.getAgreement(explicitAgreement.agreementId)).toEqual(explicitAgreement);
    } finally { await server.close(); }
  });

  it("returns specific preflight errors without creating downgraded tasks", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-contract-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    const fullAuthority = { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true };
    const cases: Array<[string, (value: Record<string, any>) => void, Record<string, boolean>, string]> = [
      ["PROVIDER", (value) => { value.authority.allowProviderCalls = false; }, fullAuthority, "provider_permission_denied"],
      ["NETWORK", (value) => { value.authority.allowNetwork = false; value.runtime.externalNetwork = "denied"; }, fullAuthority, "network_permission_denied"],
      ["MUTATION", () => undefined, { ...fullAuthority, localBranch: false, localCommit: false }, "mutation_authority_denied"],
      ["COMMIT", () => undefined, { ...fullAuthority, localCommit: false }, "local_commit_authority_denied"],
      ["RUNTIME", (value) => { value.runtime.preference = "docker"; }, fullAuthority, "preflight_contract_rejected"]
    ];
    try {
      for (const [name, mutate, authority, code] of cases) {
        const value = spec(repo, `EXECUTOR-${name}-PREFLIGHT`, "fix", ["node test.js"]); mutate(value);
        const response = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: value, authority }) });
        expect(response.status).toBeGreaterThanOrEqual(400); const error = await response.json(); expect(error).toMatchObject({ error: { code, details: { operation: "start_new_task", newTaskRequired: true } } });
        if (name === "RUNTIME") expect(error).toMatchObject({ error: { code: "preflight_contract_rejected", message: expect.stringContaining("local-disposable"), details: { schemaVersion: 1, outcome: "preflight_contract_rejected", rejection: "runtime_capability_mismatch", executorId: "local-coding-agent", requestedRuntime: "docker", allowedValues: ["docker", "local-disposable"], compatibleRuntimes: ["local-disposable"], correctedRequest: { taskSpec: { runtime: { preference: "local-disposable" } } } } } });
      }
      expect(await server.manager.store.listTasks()).toHaveLength(0);
      await expect(access(join(state, "tasks", "EXECUTOR-RUNTIME-PREFLIGHT", "task-spec.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await server.close(); }
  });

  it("uses the documented compatible runtime when implementation runtime is omitted", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-default-runtime-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const value: Record<string, any> = spec(repo, "EXECUTOR-DEFAULT-RUNTIME-1", "fix", ["node test.js"]); delete value.runtime.preference;
      const response = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: value, authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ selection: { selectedExecutor: "local-coding-agent", selectedRuntime: "local-disposable" } });
    } finally { await server.close(); }
  });

  it("cancels a live coding process and revokes its execution lease", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-cancel-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-CANCEL-1", "CANCEL_FOREVER", ["node test.js"]), authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(created.status).toBe(202); await pollPhase(`${server.url}/v1/tasks/EXECUTOR-CANCEL-1`, "implement");
      const cancelled = await fetch(`${server.url}/v1/tasks/EXECUTOR-CANCEL-1/cancel`, { method: "POST" }).then((response) => response.json()) as Record<string, any>;
      expect(cancelled).toMatchObject({ status: "interrupted", progress: { workerStatus: "cancelled" }, execution: { lease: { state: "revoked" } } });
    } finally { await server.close(); }
  }, 20_000);
});

async function repository(withSensitiveContext = false): Promise<string> { const repo = await mkdtemp(join(tmpdir(), "runforge-implementation-repo-")); await cp(fixture, repo, { recursive: true }); if (withSensitiveContext) { const path = join(repo, "calculator.js"); const source = await readFile(path, "utf8"); const context = ["// API", "_KEY=", "existingvalue", "\n"].join(""); await writeFile(path, context + source); } await git(repo, ["init", "-b", "main"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]); return repo; }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
function spec(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []) { return { schemaVersion: 2, taskId, task: { text, goal: "Make the deterministic fixture satisfy acceptance", acceptanceCriteria: ["validation is green", "local patch evidence exists"] }, target: { repository: repo, workingDirectory: "." }, execution: { mode: "implementation", maxRepairIterations: 2 }, providerRouting: { provider: "local", fallbackPolicy: "none", models: {}, maxCalls: 32, tokenBudget: { total: 100_000, perPhase: { logCompression: 10_000 } }, timeoutMs: 300_000, retry: { maxAttempts: 1 } }, runtime: { preference: "local-disposable", externalNetwork: "allowed", dependencyPreparation: "disabled" }, validation: { mode: "explicit", commands }, authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: true, forbiddenAreas }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; }
async function execute(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []): Promise<Record<string, any>> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-artifacts-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); if (text.includes("SEMANTIC_TIMEOUT")) { value.execution.timeoutMs = 1_000; value.providerRouting.timeoutMs = 1_000; } value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); await runTaskSpecFile(specPath, { logCompressionInvoker: testLogCompressionInvoker }); return JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")); }
async function executeWithExecution(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[], executionAgreement: Record<string, unknown>, executionId?: string, executionMode: "implementation" | "repair" = "implementation", attempt?: number, dirtyPolicy?: string): Promise<{ execution: Awaited<ReturnType<typeof runTaskSpecFile>>; result: Record<string, any> }> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-agreement-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); value.execution.mode = executionMode; value.executionAgreement = executionAgreement; if (dirtyPolicy) value.target.dirtyPolicy = dirtyPolicy; value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); const execution = await runTaskSpecFile(specPath, { executionId, attempt, logCompressionInvoker: testLogCompressionInvoker }); return { execution, result: JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")) }; }
async function poll(url: string): Promise<Record<string, any>> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("task did not finish"); }
async function pollPhase(url: string, phase: string): Promise<void> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (task.progress?.phase === phase) return; await new Promise((done) => setTimeout(done, 25)); } throw new Error(`task did not reach ${phase}`); }
async function downgradeCheckpointToLegacy(state: string, taskId: string, checkpointId: string): Promise<{ checkpointPath: string; manifestPath: string; manifest: Record<string, unknown> }> { const artifacts = join(state, "tasks", taskId, "attempts", "1", "artifacts"); const checkpointPath = join(artifacts, "checkpoints", checkpointId); const record = (await readdir(checkpointPath, { withFileTypes: true })).find((item) => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)); if (!record) throw new Error("missing immutable checkpoint record"); const recordPath = join(checkpointPath, record.name), manifestPath = join(checkpointPath, "manifest.json"); const current = JSON.parse(await readFile(join(recordPath, "manifest.json"), "utf8")) as Record<string, unknown>; const { taskId: _taskId, executionAgreementId: _agreementId, workspace, ...legacy } = current; legacy.schemaVersion = 1; legacy.status = "available"; legacy.workspaceSha = objectValue(workspace).sha ?? null; legacy.workspaceState = objectValue(workspace).state ?? "dirty"; await chmod(checkpointPath, 0o700); for (const name of ["patch.diff", "changed-files.json", "validation.json", "usage.json", "executor.json", "safety.json", "unresolved-findings.json"]) { const target = join(checkpointPath, name); await cp(join(recordPath, name), target); await chmod(target, 0o600); } await chmod(recordPath, 0o700); await rm(recordPath, { recursive: true }); legacy.files = (legacy.files as Array<Record<string, unknown>>).filter((entry) => ["patch.diff", "changed-files.json", "validation.json", "usage.json", "executor.json", "safety.json", "unresolved-findings.json"].includes(String(entry.path))); await writeFile(manifestPath, JSON.stringify(legacy, null, 2) + "\n"); for (const resultPath of [join(artifacts, "results.json"), join(state, "tasks", taskId, "result.json")]) { const document = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, any>; const result = document.result ?? document; for (const checkpoint of result.artifact.checkpoints) { checkpoint.path = `checkpoints/${checkpointId}`; checkpoint.patchPath = `checkpoints/${checkpointId}/patch.diff`; delete checkpoint.digest; } result.artifacts.checkpoints = [`checkpoints/${checkpointId}`]; await writeFile(resultPath, JSON.stringify(document, null, 2) + "\n"); } return { checkpointPath, manifestPath, manifest: legacy }; }
async function directorySnapshot(path: string): Promise<Record<string, Buffer>> { return Object.fromEntries(await Promise.all((await readdir(path)).sort().map(async (name) => [name, await readFile(join(path, name))] as const))); }
async function restoreDirectory(path: string, snapshot: Record<string, Buffer>): Promise<void> { await Promise.all(Object.entries(snapshot).map(([name, content]) => writeFile(join(path, name), content))); }
async function rewriteLegacyPayload(checkpointPath: string, name: string, value: unknown): Promise<string> { const payload = Buffer.from(JSON.stringify(value, null, 2) + "\n"); await writeFile(join(checkpointPath, name), payload); const manifestPath = join(checkpointPath, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>; const entry = manifest.files.find((item: Record<string, unknown>) => item.path === name); entry.bytes = payload.byteLength; entry.sha256 = digestFile(payload); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n"); return digestFile(await readFile(manifestPath)); }
function digestFile(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function pollManager(manager: ControlPlaneManager, taskId: string): Promise<Record<string, any>> { for (let index = 0; index < 200; index += 1) { const task = await manager.getTask(taskId); if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("manager task did not finish"); }
function objectValue(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
