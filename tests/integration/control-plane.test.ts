import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { startControlPlaneServer, type ControlPlaneServerInstance } from "../../src/control-plane/server.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";

const roots: string[] = [];
const servers: ControlPlaneServerInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((item) => item.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("local control-plane HTTP lifecycle", () => {
  it("discovers the dynamic URL, runs a durable task, and keeps decisions idempotent", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-http-"))) - 1]!;
    let ownerWrites = 0;
    const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, {
      runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "results.json"), JSON.stringify({ schemaVersion: 1, taskId: spec.taskId, status: "completed", diagnostic: "token=supersecret123", ownerGate: { required: false, status: "not_required" } })); return {} as never; },
      recordOwnerDecision: async ({ run }) => { ownerWrites += 1; const path = join(run, "owner-decision.json"); await mkdir(run, { recursive: true }); await writeFile(path, "{}\n"); return { decisionId: "rail-decision-1", path }; },
      continueExecution: async ({ run }) => { await writeFile(join(run, "results.json"), JSON.stringify({ schemaVersion: 1, taskId: "CONTROL-HTTP-1", status: "completed", ownerGate: { required: false, status: "not_required" } })); return {} as never; }
    });
    const instance = await startControlPlaneServer({ host: "127.0.0.1", port: 0, stateRoot, manager }); servers.push(instance);
    expect((await json(await fetch(`${instance.url}/.well-known/runforge`))).baseUrl).toBe(instance.url);
    const taskSpec = { schemaVersion: 2, taskId: "CONTROL-HTTP-1", task: { text: "Inspect RunForge", goal: "Exercise lifecycle", acceptanceCriteria: ["Durable result"] }, target: { repository: process.cwd(), workingDirectory: "." }, authority: { profile: "read-only", allowProviderCalls: false }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } };
    const created = await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec, authority: { implementation: true }, publication: "draft-pr" }) }); expect(created.status).toBe(202);
    await eventually(async () => (await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1`))).status === "completed");
    const result = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/result`)); expect(result.diagnostic).toBe("token=[REDACTED]");
    const invalidSpec = { ...taskSpec, taskId: "CONTROL-BAD-PATH", target: { repository: "/definitely/missing", workingDirectory: "." } };
    expect((await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: invalidSpec }) })).status).toBe(422);
    const task = await manager.getTask("CONTROL-HTTP-1"); task.status = "awaiting_owner_decision"; task.ownerGate = { required: true, status: "awaiting_owner_decision" }; task.authority.implementation = true; await writeFile(join(task.artifactRoot, "continuation-state.json"), JSON.stringify({ repo: process.cwd(), sourceBranch: "main", patchPackageHash: "a", patchDiffHash: "b" })); await store.saveTask(task);
    const body = JSON.stringify({ decisionId: "owner-idempotency-1", decision: "approve", note: "Explicit local-only approval" });
    const first = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    const replay = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(first.runforgeDecisionId).toBe("rail-decision-1"); expect(replay.idempotentReplay).toBe(true); expect(ownerWrites).toBe(1);
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/continue`, { method: "POST" })).status).toBe(202);
    await eventually(async () => (await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1`))).status === "completed");
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/continue`, { method: "POST" })).status).toBe(202);
    const publication = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/publication-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "publication-1", decision: "approve", note: "No provider mutation" }) }));
    expect(publication).toMatchObject({ status: "blocked_missing_authority", executed: false, providerCalls: false });
    const publicationReplay = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/publication-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "publication-1", decision: "approve", note: "No provider mutation" }) }));
    expect(publicationReplay.idempotentReplay).toBe(true);
  });

  it("rejects non-local binds, malformed input, oversized bodies, and foreign origins", async () => {
    await expect(startControlPlaneServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow("localhost");
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-security-"))) - 1]!;
    const instance = await startControlPlaneServer({ port: 0, stateRoot, maxRequestBytes: 32 }); servers.push(instance);
    expect((await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect((await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(100) }) })).status).toBe(413);
    expect((await fetch(`${instance.url}/healthz`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    const malformed = await json(await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    expect(malformed).toMatchObject({ schemaVersion: 1, error: { code: "malformed_json", retryable: false, details: {} } });
  });

  it("restores missing or corrupt continuation state and applies continuation once", async () => {
    for (const damage of ["missing", "corrupt"] as const) {
      const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), `runforge-continuation-${damage}-`))) - 1]!;
      const store = new ControlPlaneStore(stateRoot); let continues = 0;
      const manager = new ControlPlaneManager(store, {
        runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "continuation-state.json"), JSON.stringify({ schemaVersion: 1, repo: process.cwd(), sourceBranch: "main", patchPackageHash: "package", patchDiffHash: "diff" })); await writeFile(join(root, "results.json"), JSON.stringify({ status: "awaiting_owner_decision", ownerGate: { required: true, status: "awaiting_owner_decision" } })); return {} as never; },
        recordOwnerDecision: async ({ run }) => { const path = join(run, "owner-decision.json"); await writeFile(path, "{}\n"); return { decisionId: "rail-decision", path }; },
        continueExecution: async ({ run }) => { continues += 1; JSON.parse(await readFile(join(run, "continuation-state.json"), "utf8")); await writeFile(join(run, "results.json"), JSON.stringify({ status: "completed", ownerGate: { required: false, status: "not_required" } })); return {} as never; }
      }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 5_000, executionTimeoutMs: 10_000 });
      const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance);
      const id = `CONTROL-${damage.toUpperCase()}-1`; await submit(instance.url, id); await eventually(async () => (await manager.getTask(id)).status === "awaiting_owner_decision");
      await fetch(`${instance.url}/v1/tasks/${id}/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: `decision-${damage}`, decision: "approve", note: "approved" }) });
      const native = join(store.taskDir(id), "artifacts", "continuation-state.json"); if (damage === "missing") await rm(native); else await writeFile(native, "{broken");
      const responses = await Promise.all([fetch(`${instance.url}/v1/tasks/${id}/continue`, { method: "POST" }), fetch(`${instance.url}/v1/tasks/${id}/continue`, { method: "POST" })]); expect(responses.every((response) => response.status === 202)).toBe(true);
      await eventually(async () => (await manager.getTask(id)).status === "completed"); expect(continues).toBe(1); expect((await manager.getTask(id)).continuation.state).toBe("consumed");
    }
  });

  it("emits execution heartbeats, cancels safely, and reports degraded task aggregates", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-watchdog-"))) - 1]!; const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, { runTaskSpec: async () => { await new Promise((done) => setTimeout(done, 80)); return {} as never; }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 30, executionTimeoutMs: 1_000 });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-CANCEL-1");
    await new Promise((done) => setTimeout(done, 20)); const active = await manager.getTask("CONTROL-CANCEL-1"); expect(active.progress.workerStatus).toBe("active"); expect(Date.parse(active.progress.lastHeartbeatAt!)).toBeGreaterThan(Date.parse(active.progress.startedAt!));
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-CANCEL-1/cancel`, { method: "POST" })).status).toBe(200); expect((await fetch(`${instance.url}/v1/tasks/CONTROL-CANCEL-1/cancel`, { method: "POST" })).status).toBe(200);
    await new Promise((done) => setTimeout(done, 90)); expect(await manager.getTask("CONTROL-CANCEL-1")).toMatchObject({ status: "interrupted", progress: { workerStatus: "cancelled" }, recovery: { reason: "cancelled_by_operator" } });
    const now = new Date(Date.now() - 60_000).toISOString(); const lost = { ...(await manager.getTask("CONTROL-CANCEL-1")), id: "CONTROL-LOST-1", status: "running" as const, updatedAt: now, finishedAt: null, progress: { ...active.progress, executionId: "lost-worker", updatedAt: now, lastHeartbeatAt: now, workerStatus: "active" as const } }; await store.saveTask(lost);
    const health = await manager.health(); expect(health).toMatchObject({ service: { status: "healthy" }, readiness: { acceptingNewTasks: true, status: "ready_with_degraded_tasks" }, tasks: { interrupted: 2, stalled: 1 } }); expect((await manager.getTask("CONTROL-LOST-1")).status).toBe("interrupted");
  });

  it("returns a formal interruption when no continuation artifact can be trusted", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-unrecoverable-"))) - 1]!; const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, { runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "results.json"), JSON.stringify({ status: "awaiting_owner_decision", ownerGate: { required: true, status: "awaiting_owner_decision" } })); return {} as never; }, recordOwnerDecision: async () => { throw new Error("must not apply"); }, continueExecution: async () => ({} as never) });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-UNRECOVERABLE-1"); await eventually(async () => (await manager.getTask("CONTROL-UNRECOVERABLE-1")).status === "awaiting_owner_decision");
    const response = await fetch(`${instance.url}/v1/tasks/CONTROL-UNRECOVERABLE-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "unrecoverable-decision", decision: "approve", note: "approved" }) }); expect(response.status).toBe(409); expect(await json(response)).toMatchObject({ schemaVersion: 1, error: { code: "continuation_state_unrecoverable", retryable: false, taskId: "CONTROL-UNRECOVERABLE-1" } }); expect((await manager.getTask("CONTROL-UNRECOVERABLE-1")).status).toBe("interrupted");
  });
});

async function json(response: Response): Promise<Record<string, any>> { return response.json() as Promise<Record<string, any>>; }
async function eventually(check: () => Promise<boolean>): Promise<void> { for (let attempt = 0; attempt < 400; attempt += 1) { if (await check()) return; await new Promise((done) => setTimeout(done, 10)); } throw new Error("timed out"); }
async function submit(base: string, taskId: string): Promise<void> { const taskSpec = { schemaVersion: 2, taskId, task: { text: "Synthetic lifecycle", goal: "Exercise control plane", acceptanceCriteria: ["formal result"] }, target: { repository: process.cwd(), workingDirectory: "." }, authority: { profile: "read-only", allowProviderCalls: false }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec, authority: { implementation: true } }) }); expect(response.status).toBe(202); }
