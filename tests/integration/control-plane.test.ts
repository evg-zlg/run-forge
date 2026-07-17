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
    const task = await manager.getTask("CONTROL-HTTP-1"); task.status = "awaiting_owner_decision"; task.ownerGate = { required: true, status: "awaiting_owner_decision" }; task.authority.implementation = true; await store.saveTask(task);
    const body = JSON.stringify({ decisionId: "owner-idempotency-1", decision: "approve", note: "Explicit local-only approval" });
    const first = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    const replay = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(first.runforgeDecisionId).toBe("rail-decision-1"); expect(replay.idempotentReplay).toBe(true); expect(ownerWrites).toBe(1);
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/continue`, { method: "POST" })).status).toBe(202);
    await eventually(async () => (await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1`))).status === "completed");
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/continue`, { method: "POST" })).status).toBe(409);
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
  });
});

async function json(response: Response): Promise<Record<string, any>> { return response.json() as Promise<Record<string, any>>; }
async function eventually(check: () => Promise<boolean>): Promise<void> { for (let attempt = 0; attempt < 50; attempt += 1) { if (await check()) return; await new Promise((done) => setTimeout(done, 10)); } throw new Error("timed out"); }
