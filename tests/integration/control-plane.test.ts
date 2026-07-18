import { execFileSync } from "node:child_process";
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
    const taskSpec = { schemaVersion: 2, taskId: "CONTROL-HTTP-1", task: { text: "Inspect RunForge", goal: "Exercise lifecycle", acceptanceCriteria: ["Durable result"] }, target: { repository: process.cwd(), workingDirectory: "." }, execution: { mode: "validation" }, authority: { profile: "read-only", allowProviderCalls: false }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } };
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
    expect((await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/cancel`, { method: "POST" }))).status).toBe("completed");
    const publication = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/publication-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "publication-1", decision: "approve", note: "No provider mutation" }) }));
    expect(publication).toMatchObject({ status: "blocked_missing_authority", executed: false, providerCalls: false });
    const publicationReplay = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-HTTP-1/publication-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "publication-1", decision: "approve", note: "No provider mutation" }) }));
    expect(publicationReplay.idempotentReplay).toBe(true);
  });

  it("negotiates durable agreements, binds them to tasks, and rejects only RunForge conflicts", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-agreements-"))) - 1]!;
    const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, {
      runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "results.json"), JSON.stringify({ schemaVersion: 1, taskId: spec.taskId, status: "completed", ownerGate: { required: false, status: "not_required" } })); return {} as never; },
      recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never)
    });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance);

    const discovery = await json(await fetch(`${instance.url}/.well-known/runforge`));
    expect(discovery).toMatchObject({ executionAgreements: { schemaVersion: 1, schemaUrl: "/schemas/execution-agreement-v1.schema.json", profiles: expect.arrayContaining(["custom"]), parties: expect.arrayContaining(["runforge", "external_session", "owner"]), endpoints: { negotiate: "/v1/execution-agreements/negotiate", agreement: "/v1/execution-agreements/{id}", taskAgreement: "/v1/tasks/{id}/agreement" }, technicalCapabilities: { implementation: true, deploy: false }, minimalRequest: { schemaVersion: 1, profile: "assist-only" } } });
    expect((await fetch(`${instance.url}/schemas/execution-agreement-v1.schema.json`)).status).toBe(200);
    expect(await json(await fetch(`${instance.url}/v1/capabilities`))).toMatchObject({ schemas: { executionAgreement: "/schemas/execution-agreement-v1.schema.json" }, executionAgreements: { phases: expect.arrayContaining(["implementation", "deploy"]) } });

    const negotiation = await fetch(`${instance.url}/v1/execution-agreements/negotiate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, profile: "custom", requestedOwnership: { taskAnalysis: "runforge", deploy: "external_system" } }) });
    expect(negotiation.status).toBe(201); const agreement = await json(negotiation);
    expect(agreement).toMatchObject({ status: "ready", conflicts: [], handoffs: [{ phaseId: "deploy", responsibleParty: "external_system" }] });
    expect(await json(await fetch(`${instance.url}/v1/execution-agreements/${agreement.agreementId}`))).toEqual(agreement);

    const referencedSpec = { ...taskSpec("CONTROL-AGREEMENT-REF-1"), executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: { taskAnalysis: "runforge", deploy: "external_system" } } };
    const created = await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: referencedSpec, agreementId: agreement.agreementId }) });
    expect(created.status).toBe(202); expect(await json(created)).toMatchObject({ executionAgreement: { agreementId: agreement.agreementId } });
    await eventually(async () => (await manager.getTask("CONTROL-AGREEMENT-REF-1")).status === "completed");
    expect(await json(await fetch(`${instance.url}/v1/tasks/CONTROL-AGREEMENT-REF-1/agreement`))).toEqual(agreement);
    expect((await new ControlPlaneStore(stateRoot).getTask("CONTROL-AGREEMENT-REF-1"))?.executionAgreement).toEqual(agreement);

    const conflictingSpec = { ...taskSpec("CONTROL-AGREEMENT-CONFLICT-1"), executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: { deploy: "runforge" } } };
    const rejected = await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: conflictingSpec }) });
    expect(rejected.status).toBe(409); expect(await json(rejected)).toMatchObject({ error: { code: "execution_agreement_conflict", taskId: "CONTROL-AGREEMENT-CONFLICT-1", details: { conflicts: [{ phaseId: "deploy", kind: "unavailable" }] } } });
    expect(await store.getTask("CONTROL-AGREEMENT-CONFLICT-1")).toBeNull();

    const delegatedSpec = { ...taskSpec("CONTROL-AGREEMENT-DELEGATED-1"), executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "external_session", merge: "owner" } } };
    const delegated = await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: delegatedSpec }) });
    expect(delegated.status).toBe(202); expect(await json(delegated)).toMatchObject({ executionAgreement: { status: "ready", conflicts: [], handoffs: [{ phaseId: "implementation", responsibleParty: "external_session" }, { phaseId: "merge", responsibleParty: "owner" }] } });
  });

  it("settles agreement-aware external handoffs successfully with durable, bounded public lifecycle projections", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-handoffs-"))) - 1]!;
    const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, {
      runTaskSpec: async (specPath) => {
        const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; const party = spec.executionAgreement.phaseOwnership.implementation as "external_session" | "external_system";
        const status = party === "external_session" ? "awaiting_external_session" : "runforge_scope_completed";
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "results.json"), JSON.stringify({
          schemaVersion: 1, contract: "runforge-task-result", taskId: spec.taskId, status,
          agreement: { agreementId: "ea_v1_aaaaaaaaaaaaaaaaaaaaaaaa", profile: "custom", status: "in_progress", phaseOwnership: [{ phaseId: "taskAnalysis", responsibleParty: "runforge" }, { phaseId: "implementation", responsibleParty: party }], runforgeCompletedPhases: ["taskAnalysis"], delegatedPhases: [{ phaseId: "implementation", responsibleParty: party }], awaitingPhases: [{ phaseId: "implementation", responsibleParty: party, prerequisites: ["local evidence"] }] },
          next: { party, exactAction: `Complete implementation in ${party}.`, gates: [], evidence: [] },
          providerCalls: [{ stdout: "x".repeat(2_000_000), stderr: "", stdoutArtifact: "provider/iteration-0.stdout.log" }], ownerGate: { required: false, status: "not_required" }
        }));
        return {} as never;
      }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never)
    });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance);

    for (const [suffix, party] of [["SESSION", "external_session"], ["SYSTEM", "external_system"]] as const) {
      const id = `CONTROL-HANDOFF-${suffix}-1`; const spec = { ...taskSpec(id), executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: { taskAnalysis: "runforge", implementation: party } } };
      const created = await json(await fetch(`${instance.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec, authority: { implementation: true } }) }));
      const agreementId = created.executionAgreement.agreementId;
      expect(created.progress.agreement).toMatchObject({ schemaVersion: 1, agreementId, profile: "custom", currentPhase: "taskAnalysis", responsibleParty: "runforge" });
      await eventually(async () => (await manager.getTask(id)).status === "completed");
      const task = await json(await fetch(`${instance.url}/v1/tasks/${id}`));
      expect(task).toMatchObject({ status: "completed", executionAgreement: { agreementId }, progress: { agreement: { schemaVersion: 1, agreementId, profile: "custom", currentPhase: "implementation", responsibleParty: party, runforgeCompletedPhases: ["taskAnalysis"], delegatedPhases: [{ phaseId: "implementation", responsibleParty: party }], awaitingPhases: [{ phaseId: "implementation", responsibleParty: party, prerequisites: ["local evidence"] }], nextParty: party, nextAction: `Complete implementation in ${party}.`, conflicts: [], ownerGate: { required: false } } } });
      const response = await fetch(`${instance.url}/v1/tasks/${id}/result`); expect(response.status).toBe(200); const body = await response.text(); expect(body.length).toBeLessThan(30_000); const result = JSON.parse(body);
      expect(result).toMatchObject({ status: party === "external_session" ? "awaiting_external_session" : "runforge_scope_completed", providerCalls: [{ stdoutArtifact: "provider/iteration-0.stdout.log" }], controlPlane: { status: "completed", agreement: { agreementId, currentPhase: "implementation", responsibleParty: party, nextParty: party }, responseBounds: { truncated: true, truncatedFields: ["providerCalls.0.stdout"] } } });
      expect((await manager.cancelTask(id)).executionAgreement?.agreementId).toBe(agreementId);
      expect((await new ControlPlaneStore(stateRoot).getTask(id))?.executionAgreement?.agreementId).toBe(agreementId);
    }
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
      const native = join((await manager.getTask(id)).artifactRoot, "continuation-state.json"); if (damage === "missing") await rm(native); else await writeFile(native, "{broken");
      const responses = await Promise.all([fetch(`${instance.url}/v1/tasks/${id}/continue`, { method: "POST" }), fetch(`${instance.url}/v1/tasks/${id}/continue`, { method: "POST" })]); expect(responses.every((response) => response.status === 202)).toBe(true);
      await eventually(async () => (await manager.getTask(id)).status === "completed"); expect(continues).toBe(1); expect((await manager.getTask(id)).continuation.state).toBe("consumed");
    }
  });

  it("emits execution heartbeats, cancels safely, and reports degraded task aggregates", { timeout: 15_000 }, async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-watchdog-"))) - 1]!; const store = new ControlPlaneStore(stateRoot); let executions = 0;
    const manager = new ControlPlaneManager(store, { runTaskSpec: async (specPath) => { const run = ++executions; if (run === 1) await new Promise((done) => setTimeout(done, 80)); else { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "results.json"), JSON.stringify({ status: "completed", ownerGate: { required: false, status: "not_required" } })); } return {} as never; }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 30, executionTimeoutMs: 1_000 });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-CANCEL-1");
    await new Promise((done) => setTimeout(done, 20)); const active = await manager.getTask("CONTROL-CANCEL-1"); const cancelAgreementId = active.executionAgreement?.agreementId; expect(active.progress.workerStatus).toBe("active"); expect(Date.parse(active.progress.lastHeartbeatAt!)).toBeGreaterThan(Date.parse(active.progress.startedAt!));
    expect((await fetch(`${instance.url}/v1/tasks/CONTROL-CANCEL-1/cancel`, { method: "POST" })).status).toBe(200); expect((await fetch(`${instance.url}/v1/tasks/CONTROL-CANCEL-1/cancel`, { method: "POST" })).status).toBe(200);
    await new Promise((done) => setTimeout(done, 90)); const cancelled = await manager.getTask("CONTROL-CANCEL-1"); expect(cancelled).toMatchObject({ status: "interrupted", executionAgreement: { agreementId: cancelAgreementId }, progress: { agreement: { agreementId: cancelAgreementId } }, recovery: { reason: "cancelled_by_operator", retryAvailable: true } }); expect(["completed", "not_required"]).toContain(cancelled.recovery?.cleanupStatus);
    const now = new Date(Date.now() - 60_000).toISOString(); const lost = { ...(await manager.getTask("CONTROL-CANCEL-1")), id: "CONTROL-LOST-1", status: "running" as const, updatedAt: now, finishedAt: null, progress: { ...active.progress, executionId: "lost-worker", updatedAt: now, lastHeartbeatAt: now, workerStatus: "active" as const } }; await store.saveTask(lost);
    const health = await manager.health(); expect(health).toMatchObject({ service: { status: "healthy" }, readiness: { acceptingNewTasks: true }, tasks: { active: 0, interrupted: 2 } }); expect((await manager.getTask("CONTROL-LOST-1")).status).toBe("interrupted");
    await manager.retryTask("CONTROL-CANCEL-1"); await eventually(async () => (await manager.getTask("CONTROL-CANCEL-1")).status === "completed"); expect(executions).toBe(2);
  });

  it("returns a formal interruption when no continuation artifact can be trusted", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-unrecoverable-"))) - 1]!; const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, { runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "results.json"), JSON.stringify({ status: "awaiting_owner_decision", ownerGate: { required: true, status: "awaiting_owner_decision" } })); return {} as never; }, recordOwnerDecision: async () => { throw new Error("must not apply"); }, continueExecution: async () => ({} as never) });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-UNRECOVERABLE-1"); await eventually(async () => (await manager.getTask("CONTROL-UNRECOVERABLE-1")).status === "awaiting_owner_decision");
    const response = await fetch(`${instance.url}/v1/tasks/CONTROL-UNRECOVERABLE-1/owner-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId: "unrecoverable-decision", decision: "approve", note: "approved" }) }); expect(response.status).toBe(409); expect(await json(response)).toMatchObject({ schemaVersion: 1, error: { code: "continuation_state_unrecoverable", retryable: false, taskId: "CONTROL-UNRECOVERABLE-1" } }); expect((await manager.getTask("CONTROL-UNRECOVERABLE-1")).status).toBe("interrupted");
  });

  it("continues from the authority-bound snapshot after a manager restart", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-restart-continuation-"))) - 1]!; const store = new ControlPlaneStore(stateRoot);
    const operations = { runTaskSpec: async (specPath: string) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "continuation-state.json"), JSON.stringify({ schemaVersion: 1, repo: process.cwd(), sourceBranch: "main", patchPackageHash: "package", patchDiffHash: "diff" })); await writeFile(join(root, "results.json"), JSON.stringify({ status: "awaiting_owner_decision", ownerGate: { required: true, status: "awaiting_owner_decision" } })); return {} as never; }, recordOwnerDecision: async ({ run }: { run: string }) => { const path = join(run, "owner-decision.json"); await writeFile(path, "{}\n"); return { decisionId: "restart-rail-decision", path }; }, continueExecution: async ({ run }: { run: string }) => { await writeFile(join(run, "results.json"), JSON.stringify({ status: "completed", ownerGate: { required: false, status: "not_required" } })); return {} as never; } };
    const beforeRestart = new ControlPlaneManager(store, operations as never); await beforeRestart.initialize(); await beforeRestart.createTask({ taskSpec: taskSpec("CONTROL-RESTART-1"), authority: { inspect: true, implementation: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, publicationRequested: "none" }); await eventually(async () => (await beforeRestart.getTask("CONTROL-RESTART-1")).status === "awaiting_owner_decision"); await beforeRestart.ownerDecision("CONTROL-RESTART-1", { decisionId: "restart-decision", decision: "approve", note: "approved after restart" }); const continuationArtifact = join((await beforeRestart.getTask("CONTROL-RESTART-1")).artifactRoot, "continuation-state.json"); beforeRestart.close(); await rm(continuationArtifact);
    const afterRestart = new ControlPlaneManager(store, operations as never); await afterRestart.initialize(); await afterRestart.continueTask("CONTROL-RESTART-1"); await eventually(async () => (await afterRestart.getTask("CONTROL-RESTART-1")).status === "completed"); expect((await afterRestart.getTask("CONTROL-RESTART-1")).continuation.state).toBe("consumed"); afterRestart.close();
  });

  it("recovers a deadline interruption through HTTP without allowing a late worker to overwrite the retry", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-interrupted-retry-"))) - 1]!; const store = new ControlPlaneStore(stateRoot); let runs = 0;
    const manager = new ControlPlaneManager(store, {
      runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; const run = ++runs; await mkdir(root, { recursive: true }); if (run === 1) await new Promise((done) => setTimeout(done, 140)); await writeFile(join(root, "results.json"), JSON.stringify({ schemaVersion: 1, taskId: spec.taskId, status: "completed", marker: run === 1 ? "late-old" : "new-attempt", ownerGate: { required: false, status: "not_required" } })); return {} as never; },
      recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never)
    }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 1_000, executionTimeoutMs: 30, cleanupGraceMs: 180 });
    const repository = await syntheticRepository(); const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-DEADLINE-RETRY-1", repository);
    await eventually(async () => { await fetch(`${instance.url}/healthz`); return (await manager.getTask("CONTROL-DEADLINE-RETRY-1")).status === "interrupted"; });
    const interrupted = await json(await fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1`)); const oldExecutionId = interrupted.progress.executionId;
    expect(interrupted.recovery).toMatchObject({ reason: "execution_deadline_exceeded", retryAvailable: false, cleanupStatus: "pending" }); expect(interrupted.recovery.operation).toBeUndefined();
    expect(await json(await fetch(`${instance.url}/healthz`))).toMatchObject({ tasks: { active: 0, cleanupPending: 1 } });
    expect(await json(await fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/result`))).toMatchObject({ status: "interrupted", interruption: { originalExecutionId: oldExecutionId }, targetMutation: { status: "not_inferred" }, safetyAssertions: { staleLeaseRevoked: true, lateWorkerResultIgnored: true } });
    const pendingRetry = await fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/retry`, { method: "POST" }); expect(pendingRetry.status).toBe(409); expect(await json(pendingRetry)).toMatchObject({ error: { code: "recovery_pending", retryable: true } });
    await eventually(async () => (await manager.getTask("CONTROL-DEADLINE-RETRY-1")).recovery?.retryAvailable === true); expect((await manager.getTask("CONTROL-DEADLINE-RETRY-1")).recovery?.cleanupStatus).toBe("completed");
    const retries = await Promise.all([fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/retry`, { method: "POST" }), fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/retry`, { method: "POST" })]); expect(retries.every((response) => response.status === 202)).toBe(true);
    const retryBodies = await Promise.all(retries.map(json)); expect(retryBodies[0]!.progress.executionId).toBe(retryBodies[1]!.progress.executionId); expect(retryBodies[0]!.progress.executionId).not.toBe(oldExecutionId); expect(retryBodies[0]!.progress.attempt).toBe(2);
    await eventually(async () => (await manager.getTask("CONTROL-DEADLINE-RETRY-1")).status === "completed"); await new Promise((done) => setTimeout(done, 150));
    expect(await json(await fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/result`))).toMatchObject({ status: "completed", marker: "new-attempt" }); expect(runs).toBe(2);
    const finalTask = await manager.getTask("CONTROL-DEADLINE-RETRY-1"); expect(finalTask.execution.attempts).toHaveLength(2); expect(new Set(finalTask.execution.attempts.map((attempt) => attempt.artifactRoot)).size).toBe(2);
    const completedRetry = await fetch(`${instance.url}/v1/tasks/CONTROL-DEADLINE-RETRY-1/retry`, { method: "POST" }); expect(completedRetry.status).toBe(409); expect(await json(completedRetry)).toMatchObject({ error: { code: "task_not_retryable" } });
  });

  it("recovers stale heartbeat and cancelled executions while rejecting owner-gated retry", { timeout: 15_000 }, async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-stale-retry-"))) - 1]!; const store = new ControlPlaneStore(stateRoot); let runs = 0;
    const manager = new ControlPlaneManager(store, { runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; const run = ++runs; await mkdir(root, { recursive: true }); if (run !== 2) await new Promise((done) => setTimeout(done, 80)); else await writeFile(join(root, "results.json"), JSON.stringify({ status: "completed", ownerGate: { required: false, status: "not_required" } })); return {} as never; }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) }, { heartbeatIntervalMs: 1_000, staleHeartbeatMs: 15, executionTimeoutMs: 10_000, cleanupGraceMs: 100 });
    const instance = await startControlPlaneServer({ port: 0, stateRoot, manager }); servers.push(instance); await submit(instance.url, "CONTROL-STALE-1"); await new Promise((done) => setTimeout(done, 25)); await manager.health(); expect((await manager.getTask("CONTROL-STALE-1")).recovery?.reason).toBe("stale_heartbeat"); await eventually(async () => (await manager.getTask("CONTROL-STALE-1")).recovery?.retryAvailable === true);
    const stale = await manager.getTask("CONTROL-STALE-1"); const registry = (manager as unknown as { active: Map<string, unknown> }).active; registry.set(stale.id, { executionId: "stale-registry-entry", operation: "execution", cancelled: false, controller: new AbortController() });
    expect((await manager.retryTask(stale.id)).progress.attempt).toBe(2); await eventually(async () => (await manager.getTask(stale.id)).status === "completed");
    const ownerGated = await manager.getTask(stale.id); ownerGated.status = "awaiting_owner_decision"; await store.saveTask(ownerGated); await expect(manager.retryTask(stale.id)).rejects.toMatchObject({ code: "task_not_retryable" });
    ownerGated.status = "running"; ownerGated.execution.lease = { ...ownerGated.execution.lease!, state: "active" }; await store.saveTask(ownerGated); await manager.health(); const lost = await manager.getTask(stale.id); expect(lost).toMatchObject({ status: "interrupted", recovery: { reason: "worker_lost", retryAvailable: true }, execution: { lease: { state: "revoked" } } });
  });

  it("reconstructs an interrupted result on restart and retries with a new execution identity", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-restart-retry-"))) - 1]!; const store = new ControlPlaneStore(stateRoot); let runs = 0;
    const operations = { runTaskSpec: async (specPath: string) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; const run = ++runs; await mkdir(root, { recursive: true }); if (run === 1) await new Promise((done) => setTimeout(done, 100)); else await writeFile(join(root, "results.json"), JSON.stringify({ status: "completed", marker: "after-restart", ownerGate: { required: false, status: "not_required" } })); return {} as never; }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) };
    const before = new ControlPlaneManager(store, operations as never, { heartbeatIntervalMs: 5, staleHeartbeatMs: 1_000, executionTimeoutMs: 10_000, cleanupGraceMs: 5 }); await before.initialize(); await before.createTask({ taskSpec: taskSpec("CONTROL-RESTART-RETRY-1"), authority: { inspect: true, implementation: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, publicationRequested: "none" }); const beforeRestartTask = await before.getTask("CONTROL-RESTART-RETRY-1"); const oldExecutionId = beforeRestartTask.progress.executionId; const agreementId = beforeRestartTask.executionAgreement?.agreementId; before.close();
    const after = new ControlPlaneManager(store, operations as never, { heartbeatIntervalMs: 5, staleHeartbeatMs: 1_000, executionTimeoutMs: 10_000, cleanupGraceMs: 5 }); await after.initialize(); expect((await after.getTask("CONTROL-RESTART-RETRY-1")).executionAgreement?.agreementId).toBe(agreementId); expect(await after.getResult("CONTROL-RESTART-RETRY-1")).toMatchObject({ status: "interrupted", interruption: { reason: "service_restart", originalExecutionId: oldExecutionId } }); const retried = await after.retryTask("CONTROL-RESTART-RETRY-1"); expect(retried.progress.executionId).not.toBe(oldExecutionId); expect(retried.executionAgreement?.agreementId).toBe(agreementId); await eventually(async () => (await after.getTask("CONTROL-RESTART-RETRY-1")).status === "completed"); expect(await after.getResult("CONTROL-RESTART-RETRY-1")).toMatchObject({ marker: "after-restart" }); after.close();
  });

  it("blocks retry after failed cleanup and publishes a terminal worker failure result", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-cleanup-failed-"))) - 1]!; const store = new ControlPlaneStore(stateRoot);
    const manager = new ControlPlaneManager(store, { runTaskSpec: async () => { await new Promise((done) => setTimeout(done, 120)); return {} as never; }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 1_000, executionTimeoutMs: 10, cleanupGraceMs: 10 }); await manager.initialize(); await manager.createTask({ taskSpec: taskSpec("CONTROL-CLEANUP-FAILED-1"), authority: { inspect: true, implementation: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, publicationRequested: "none" }); await eventually(async () => { await manager.health(); return (await manager.getTask("CONTROL-CLEANUP-FAILED-1")).recovery?.cleanupStatus === "detached"; }); const blocked = await manager.getTask("CONTROL-CLEANUP-FAILED-1"); expect(blocked.recovery).toMatchObject({ retryAvailable: false, cleanupStatus: "detached", actions: ["cancel", "start_new_task", "restart_control_plane"] }); await expect(manager.retryTask(blocked.id)).rejects.toMatchObject({ code: "worker_cleanup_failed", retryable: false }); await eventually(async () => (await manager.getTask(blocked.id)).recovery?.retryAvailable === true); expect((await manager.getTask(blocked.id)).recovery).toMatchObject({ cleanupStatus: "completed", actions: ["retry", "cancel"], operation: `/v1/tasks/${blocked.id}/retry` }); manager.close();
    const failureRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-worker-failed-"))) - 1]!; const failureManager = new ControlPlaneManager(new ControlPlaneStore(failureRoot), { runTaskSpec: async () => { throw new Error("synthetic worker failure"); }, recordOwnerDecision: async () => ({} as never), continueExecution: async () => ({} as never) }); await failureManager.initialize(); await failureManager.createTask({ taskSpec: taskSpec("CONTROL-WORKER-FAILED-1"), authority: { inspect: true, implementation: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, publicationRequested: "none" }); await eventually(async () => (await failureManager.getTask("CONTROL-WORKER-FAILED-1")).status === "failed"); expect(await failureManager.getResult("CONTROL-WORKER-FAILED-1")).toMatchObject({ status: "failed", error: "synthetic worker failure" }); failureManager.close();
  });

  it("retries an interrupted continuation from its source-bound snapshot in a new artifact generation", async () => {
    const stateRoot = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-continuation-retry-"))) - 1]!; const store = new ControlPlaneStore(stateRoot); let continuations = 0;
    const manager = new ControlPlaneManager(store, { runTaskSpec: async (specPath) => { const spec = JSON.parse(await readFile(specPath, "utf8")); const root = spec.artifacts.root as string; await mkdir(root, { recursive: true }); await writeFile(join(root, "continuation-state.json"), JSON.stringify({ schemaVersion: 1, repo: process.cwd(), sourceBranch: "main", patchPackageHash: "package", patchDiffHash: "diff" })); await writeFile(join(root, "results.json"), JSON.stringify({ status: "awaiting_owner_decision", ownerGate: { required: true, status: "awaiting_owner_decision" } })); return {} as never; }, recordOwnerDecision: async ({ run }) => { const path = join(run, "owner-decision.json"); await writeFile(path, "{}\n"); return { decisionId: "continuation-retry-decision", path }; }, continueExecution: async ({ run }) => { const attempt = ++continuations; if (attempt === 1) await new Promise((done) => setTimeout(done, 70)); else await writeFile(join(run, "results.json"), JSON.stringify({ status: "completed", marker: "retried-continuation", ownerGate: { required: false, status: "not_required" } })); return {} as never; } }, { heartbeatIntervalMs: 5, staleHeartbeatMs: 1_000, executionTimeoutMs: 20, cleanupGraceMs: 100 });
    await manager.initialize(); await manager.createTask({ taskSpec: taskSpec("CONTROL-CONTINUATION-RETRY-1"), authority: { inspect: true, implementation: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, publicationRequested: "none" }); await eventually(async () => (await manager.getTask("CONTROL-CONTINUATION-RETRY-1")).status === "awaiting_owner_decision"); await manager.ownerDecision("CONTROL-CONTINUATION-RETRY-1", { decisionId: "owner-continuation-retry", decision: "approve", note: "approved" }); await manager.continueTask("CONTROL-CONTINUATION-RETRY-1"); await eventually(async () => { await manager.health(); return (await manager.getTask("CONTROL-CONTINUATION-RETRY-1")).status === "interrupted"; }); await eventually(async () => (await manager.getTask("CONTROL-CONTINUATION-RETRY-1")).recovery?.retryAvailable === true); const beforeRetry = await manager.getTask("CONTROL-CONTINUATION-RETRY-1"); const oldRoot = beforeRetry.artifactRoot; const retried = await manager.retryTask(beforeRetry.id); expect(retried.artifactRoot).not.toBe(oldRoot); expect(retried.progress.attempt).toBe(3); await eventually(async () => (await manager.getTask(beforeRetry.id)).status === "completed"); expect(await manager.getResult(beforeRetry.id)).toMatchObject({ marker: "retried-continuation" }); expect(continuations).toBe(2); manager.close();
  });
});

async function json(response: Response): Promise<Record<string, any>> { return response.json() as Promise<Record<string, any>>; }
async function eventually(check: () => Promise<boolean>): Promise<void> { for (let attempt = 0; attempt < 1_500; attempt += 1) { if (await check()) return; await new Promise((done) => setTimeout(done, 10)); } throw new Error("timed out"); }
async function submit(base: string, taskId: string, repository = process.cwd()): Promise<void> { const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: taskSpec(taskId, repository), authority: { implementation: true } }) }); if (response.status !== 202) throw new Error(`Task submission failed (${response.status}): ${JSON.stringify(await json(response))}`); }
function taskSpec(taskId: string, repository = process.cwd()): Record<string, unknown> { return { schemaVersion: 2, taskId, task: { text: "Synthetic lifecycle", goal: "Exercise control plane", acceptanceCriteria: ["formal result"] }, target: { repository, workingDirectory: "." }, execution: { mode: "validation" }, authority: { profile: "read-only", allowProviderCalls: false }, validation: { mode: "explicit", commands: ["git status --short"] }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; }
async function syntheticRepository(): Promise<string> { const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-interrupted-dogfood-repo-"))) - 1]!; execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root }); execFileSync("git", ["config", "user.name", "RunForge Dogfood"], { cwd: root }); execFileSync("git", ["config", "user.email", "runforge-dogfood@example.invalid"], { cwd: root }); await writeFile(join(root, "README.md"), "# Synthetic interrupted recovery fixture\n"); execFileSync("git", ["add", "README.md"], { cwd: root }); execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root }); return root; }
