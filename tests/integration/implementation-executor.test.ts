import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";
import { discoverImplementationExecutors } from "../../src/implementation/executor.js";
import { startControlPlaneServer } from "../../src/control-plane/server.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../fixtures/implementation/simple-js");
const adapter = resolve(here, "../fixtures/implementation/coding-agent-adapter.mjs");
const previousCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND;

afterEach(() => { if (previousCommand === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; else process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = previousCommand; });

describe("implementation executor", () => {
  it("discovers a real configured backend and rejects an unavailable backend", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    expect(await discoverImplementationExecutors()).toMatchObject([{ id: "local-coding-agent", status: "ready", supports: ["implementation", "repair"], providerCalls: true }]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
    expect(await discoverImplementationExecutors()).toMatchObject([{ status: "unavailable" }]);
  });

  it("implements, repairs, validates, adds a test, commits locally, and preserves the source checkout", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const beforeStatus = await git(repo, ["status", "--porcelain"]);
    const result = await execute(repo, "EXECUTOR-SUCCESS-1", "REPAIR_LOOP ADD_TEST fix add", ["node test.js", "node added.test.js", "node lint.js", "node typecheck.js"]);
    expect(result.implementation).toMatchObject({ status: "implemented_and_validated", performed: true, changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), localCommit: expect.any(String), patchPackage: expect.any(String) });
    expect(result.validation).toHaveLength(4);
    expect((result.validation as Array<Record<string, unknown>>).every((item) => item.exitCode === 0 && typeof item.stdout === "string" && typeof item.stderr === "string")).toBe(true);
    expect(result.providerCalls).toMatchObject([{ providerCalls: true, networkAuthorized: true }, { providerCalls: true, networkAuthorized: true }]);
    expect(result.providerCalls).toMatchObject([{ tokenUsage: 100 }, { tokenUsage: 100 }]);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before); expect(await git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(await readFile(String((result.implementation as Record<string, unknown>).patchPackage), "utf8")).toContain("added.test.js");
    expect(result.publication).toMatchObject({ status: "on_hold", performed: false });
  }, 20_000);

  it.each([
    ["FALSE_POSITIVE", "no_change_required", "completed"],
    ["AMBIGUOUS_CHANGE", "blocked_with_owner_gate", "awaiting_owner_decision"],
    ["FORBIDDEN_CHANGE", "blocked_with_owner_gate", "awaiting_owner_decision"]
  ])("returns explicit outcome for %s", async (task, outcome, status) => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(), `EXECUTOR-${task}-1`, task, ["node test.js"], task === "FORBIDDEN_CHANGE" ? ["secrets.txt"] : []);
    expect(result.status).toBe(status); expect(result.implementation).toMatchObject({ status: outcome });
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
      expect(ready.implementationExecutors).toEqual(discovery.implementationExecutors); expect(discovery.implementationExecutors).toEqual(capabilities.implementationExecutors);
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true, runtime: "local" }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(discovery.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-HTTP-1"; request.taskSpec.task.text = "ADD_TEST fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js", "node added.test.js"] };
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(created.status).toBe(202);
      const accepted = await created.json() as Record<string, any>; expect(accepted.selection).toMatchObject({ requestedMode: "implementation", normalizedMode: "implementation", selectedExecutor: "local-coding-agent", selectedRuntime: "local-disposable", authorityChecks: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true }, providerDecision: "allowed", networkDecision: "allowed" });
      const terminal = await poll(`${server.url}/v1/tasks/EXECUTOR-HTTP-1`); expect(terminal.status).toBe("completed");
      expect(terminal.events.map((item: any) => item.detail).join(" ")).toContain("implement:");
      const result = await fetch(`${server.url}/v1/tasks/EXECUTOR-HTTP-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(result).toMatchObject({ requestedIntent: "implementation", actualExecutorMode: "implementation", implementation: { status: "implemented_and_validated" }, publication: { status: "on_hold", performed: false } });
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

async function repository(): Promise<string> { const repo = await mkdtemp(join(tmpdir(), "runforge-implementation-repo-")); await cp(fixture, repo, { recursive: true }); await git(repo, ["init", "-b", "main"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]); return repo; }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
function spec(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []) { return { schemaVersion: 2, taskId, task: { text, goal: "Make the deterministic fixture satisfy acceptance", acceptanceCriteria: ["validation is green", "local patch evidence exists"] }, target: { repository: repo, workingDirectory: "." }, execution: { mode: "implementation", maxRepairIterations: 2 }, runtime: { preference: "local-disposable", externalNetwork: "allowed", dependencyPreparation: "disabled" }, validation: { mode: "explicit", commands }, authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: true, forbiddenAreas }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; }
async function execute(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []): Promise<Record<string, any>> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-artifacts-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); await runTaskSpecFile(specPath); return JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")); }
async function poll(url: string): Promise<Record<string, any>> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("task did not finish"); }
async function pollPhase(url: string, phase: string): Promise<void> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (task.progress?.phase === phase) return; await new Promise((done) => setTimeout(done, 25)); } throw new Error(`task did not reach ${phase}`); }
