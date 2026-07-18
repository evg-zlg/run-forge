import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";
import { discoverImplementationExecutors } from "../../src/implementation/executor.js";
import { executionPhaseOwner } from "../../src/product/execution-agreement.js";
import { startControlPlaneServer } from "../../src/control-plane/server.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../fixtures/implementation/simple-js");
const adapter = resolve(here, "../fixtures/implementation/coding-agent-adapter.mjs");
const previousCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND;

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
    expect(await discoverImplementationExecutors()).toMatchObject([{ id: "local-coding-agent", status: "ready", supports: ["implementation", "repair"], providerCalls: true }]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
    expect(await discoverImplementationExecutors()).toMatchObject([{ status: "unavailable" }]);
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
    expect(result.providerCalls).toMatchObject([{ providerCalls: true, networkAuthorized: true }, { providerCalls: true, networkAuthorized: true }]);
    expect(result.providerCalls).toMatchObject([{ tokenUsage: 100 }, { tokenUsage: 100 }]);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      agreement: { profile: "local-ready", requestedProfile: "local-ready", effectiveProfile: "local-ready", runforgeCompletedPhases: expect.arrayContaining(["implementation", "localValidation", "patchPackage", "localBranch", "localCommit"]), awaitingPhases: expect.arrayContaining([{ phaseId: "remotePush", responsibleParty: "external_session", prerequisites: [] }]) },
      handoff: { profile: "local-ready", changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), patch: "implementation.patch", branch: "runforge/executor-success-1/standalone-attempt-1", commit: expect.any(String), findings: [] },
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
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
    expect(await readFile(String(result.implementation.patchPackage), "utf8")).toContain("diff --git");
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
      expect(capabilities.implementationExecutors).toMatchObject([{ status: "ready" }]);
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
      const negotiated = await fetch(`${server.url}${discovery.endpoints.executionAgreementNegotiation}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          schemaVersion: 1, profile: "local-ready", projectId: project.project.id,
          publicationTarget: { kind: "new_branch", branchName: "runforge/executor-http-1" },
          authority: {
            projectDiscovery: true, taskAnalysis: true, implementationPlanning: true, implementation: true,
            localValidation: true, independentReview: true, repairIterations: true, patchPackage: true,
            localBranch: true, localCommit: true, providerModelCalls: true,
          },
        }),
      }).then((response) => response.json()) as Record<string, any>;
      expect(negotiated).toMatchObject({ status: "ready", profile: "local-ready", context: { project: { projectId: project.project.id }, publicationTarget: { kind: "new_branch" } } });
      const request = structuredClone(discovery.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.agreementId = negotiated.agreementId; request.taskSpec.taskId = "EXECUTOR-HTTP-1"; request.taskSpec.task.text = "ADD_TEST fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js", "node added.test.js"] };
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
          handoff: { profile: "local-ready", findings: [], branch: "runforge[internal path]", commit: expect.any(String) },
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
      expect(persisted.result).toMatchObject({
        workflow: { handoff: { branch: expect.stringMatching(/^runforge\/executor-http-1\/[a-z0-9-]+-attempt-1$/) } },
        implementation: { localBranch: persisted.result.workflow.handoff.branch },
        git: { branch: persisted.result.workflow.handoff.branch },
      });
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
      expect(await git(repo, ["status", "--porcelain"])).toBe(sourceStatusBefore);
      expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
      expect(await git(repo, ["ls-remote", "origin"])).toBe(remoteBefore);
    } finally { await server.close(); }
  }, 20_000);

  it("blocks provider denial and unavailable executors before accepting implementation work", async () => {
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-preflight-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
      const denied = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-DENIED-1", "fix", ["node test.js"]), authority: { implementation: true, localBranch: true, localCommit: true } }) });
      expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { code: "provider_authority_denied" } });
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
      const unavailable = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-UNAVAILABLE-1", "fix", ["node test.js"]), authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ error: { code: "implementation_executor_unavailable" } });
      expect((await server.manager.store.listTasks()).map((item) => item.id)).not.toContain("EXECUTOR-UNAVAILABLE-1");
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
      ["RUNTIME", (value) => { value.runtime.preference = "docker"; }, fullAuthority, "runtime_incompatible"]
    ];
    try {
      for (const [name, mutate, authority, code] of cases) {
        const value = spec(repo, `EXECUTOR-${name}-PREFLIGHT`, "fix", ["node test.js"]); mutate(value);
        const response = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: value, authority }) });
        expect(response.status).toBeGreaterThanOrEqual(400); const error = await response.json(); expect(error).toMatchObject({ error: { code, details: { operation: "start_new_task", newTaskRequired: true } } });
        if (name === "RUNTIME") expect(error).toMatchObject({ error: { code: "runtime_incompatible", message: expect.stringContaining("local-disposable"), details: { executorId: "local-coding-agent", requestedRuntime: "docker", allowedValues: ["docker", "local-disposable"], compatibleRuntimes: ["local-disposable"], correctedRequest: { taskSpec: { runtime: { preference: "local-disposable" } } } } } });
      }
      expect(await server.manager.store.listTasks()).toHaveLength(0);
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
function spec(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []) { return { schemaVersion: 2, taskId, task: { text, goal: "Make the deterministic fixture satisfy acceptance", acceptanceCriteria: ["validation is green", "local patch evidence exists"] }, target: { repository: repo, workingDirectory: "." }, execution: { mode: "implementation", maxRepairIterations: 2 }, runtime: { preference: "local-disposable", externalNetwork: "allowed", dependencyPreparation: "disabled" }, validation: { mode: "explicit", commands }, authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: true, forbiddenAreas }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; }
async function execute(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []): Promise<Record<string, any>> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-artifacts-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); await runTaskSpecFile(specPath); return JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")); }
async function executeWithExecution(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[], executionAgreement: Record<string, unknown>, executionId?: string, executionMode: "implementation" | "repair" = "implementation", attempt?: number): Promise<{ execution: Awaited<ReturnType<typeof runTaskSpecFile>>; result: Record<string, any> }> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-agreement-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); value.execution.mode = executionMode; value.executionAgreement = executionAgreement; value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); const execution = await runTaskSpecFile(specPath, { executionId, attempt }); return { execution, result: JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")) }; }
async function poll(url: string): Promise<Record<string, any>> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("task did not finish"); }
async function pollPhase(url: string, phase: string): Promise<void> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (task.progress?.phase === phase) return; await new Promise((done) => setTimeout(done, 25)); } throw new Error(`task did not reach ${phase}`); }
