import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAuthority, parseDecisionRequest, parseTaskRequest, type ControlTaskRecord } from "../../src/control-plane/contracts.js";
import { negotiateControlPlaneAgreement, parseExecutionAgreementNegotiationRequest } from "../../src/control-plane/execution-agreements.js";
import { boundPublicResult } from "../../src/control-plane/manager.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("control-plane contracts", () => {
  it("defaults to inspect-only and enforces authority hierarchy", () => {
    expect(defaultAuthority(undefined)).toMatchObject({ inspect: true, implementation: false, remotePush: false, merge: false, deploy: false });
    expect(() => defaultAuthority({ localCommit: true })).toThrow("localBranch");
    expect(() => defaultAuthority({ merge: true })).toThrow("Merge and deploy");
  });

  it("rejects unknown fields and constrains decision vocabularies", () => {
    expect(() => parseTaskRequest({ taskSpec: {}, surprise: true })).toThrow("unknown field");
    expect(() => parseDecisionRequest({ decision: "merge", note: "no" }, "publication")).toThrow("must be one of");
  });

  it("parses bounded agreement requests and keeps unavailable RunForge work conflicted", () => {
    expect(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "assist-only" })).toMatchObject({ schemaVersion: 1, profile: "assist-only" });
    expect(() => parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", requestedOwnership: { imaginary: "runforge" } })).toThrow("unknown phase");
    expect(() => parseTaskRequest({ taskSpec: {}, agreementId: "../../state.json" })).toThrow("Execution Agreement v1 identifier");

    const conflicted = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", requestedOwnership: { deploy: "runforge" }, technicalCapability: { deploy: true } }));
    expect(conflicted).toMatchObject({ status: "conflicted", conflicts: [{ phaseId: "deploy", kind: "unavailable" }] });
    const delegated = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", requestedOwnership: { deploy: "external_system" } }));
    expect(delegated).toMatchObject({ status: "ready", conflicts: [], handoffs: [{ phaseId: "deploy", responsibleParty: "external_system" }] });
  });

  it("stores agreements durably and retrieves them after store restart", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-agreement-store-"))) - 1]!;
    const first = new ControlPlaneStore(root); await first.initialize();
    const agreement = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "assist-only" }));
    await first.saveAgreement(agreement);
    const restarted = new ControlPlaneStore(root); await restarted.initialize();
    expect(await restarted.getAgreement(agreement.agreementId)).toEqual(agreement);
  });

  it("bounds verbose public diagnostics while retaining compact result fields", () => {
    const bounded = boundPublicResult({ status: "awaiting_external_session", providerCalls: [{ stdout: "x".repeat(2_000_000), stderr: "", stdoutArtifact: "provider/iteration-0.stdout.log" }] });
    expect(bounded.result).toMatchObject({ status: "awaiting_external_session", providerCalls: [{ stdoutArtifact: "provider/iteration-0.stdout.log" }] });
    expect(JSON.stringify(bounded.result).length).toBeLessThan(20_000);
    expect(bounded.truncatedFields).toEqual(["providerCalls.0.stdout"]);
  });

  it("recovers in-flight state as interrupted without inferring success", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-store-"))) - 1]!;
    const store = new ControlPlaneStore(root); await store.initialize();
    const now = new Date().toISOString();
    await store.saveTask({ id: "RECOVERY-1", projectId: null, status: "running", specPath: "/tmp/spec", artifactRoot: "/tmp/artifacts", authority: defaultAuthority(undefined), publicationRequested: "none", publicationGate: { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" }, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, error: null, decisions: [], events: [], progress: { phase: "execution", operation: "execution", startedAt: now, updatedAt: now, lastHeartbeatAt: now, executionId: "old-worker", attempt: 1, workerStatus: "active", timeoutMs: 300000, deadlineAt: null, summary: "active", diagnostic: null }, recovery: null, execution: { attempt: 1, lease: { executionId: "old-worker", attempt: 1, operation: "execution", state: "active", startedAt: now, revokedAt: null, cleanupDeadlineAt: null }, attempts: [], lastRetry: null }, continuation: { schemaVersion: 1, state: "none", decisionId: null, executionId: null, sourceExecutionId: null } });
    await new ControlPlaneStore(root).initialize();
    expect(await store.getTask("RECOVERY-1")).toMatchObject({ status: "interrupted", execution: { lease: { state: "revoked" } }, recovery: { retryAvailable: true, cleanupStatus: "not_required" } });
  });

  it("lets the interruption journal override a stale durable running snapshot", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-journal-"))) - 1]!; const store = new ControlPlaneStore(root); await store.initialize(); const now = new Date().toISOString();
    const task = { id: "JOURNAL-1", projectId: null, status: "running" as const, specPath: "/tmp/spec", artifactRoot: "/tmp/artifacts", authority: defaultAuthority(undefined), publicationRequested: "none" as const, publicationGate: { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" }, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, error: null, decisions: [], events: [], progress: { phase: "validation", operation: "execution", startedAt: now, updatedAt: now, lastHeartbeatAt: now, executionId: "journal-worker", attempt: 3, workerStatus: "active" as const, timeoutMs: 300000, deadlineAt: null, summary: "stale snapshot", diagnostic: null }, recovery: null, execution: { attempt: 3, lease: { executionId: "journal-worker", attempt: 3, operation: "execution" as const, state: "active" as const, startedAt: now, revokedAt: null, cleanupDeadlineAt: null }, attempts: [], lastRetry: null }, continuation: { schemaVersion: 1 as const, state: "none" as const, decisionId: null, executionId: null, sourceExecutionId: null } };
    await store.saveTask(task); await store.appendEvent(task.id, { at: now, type: "task_interrupted", detail: "stale_heartbeat", executionId: "journal-worker" }); await new ControlPlaneStore(root).initialize(); expect(await store.getTask(task.id)).toMatchObject({ status: "interrupted", recovery: { reason: "stale_heartbeat", retryAvailable: true } });
  });

  it("ignores a late terminal event from the same revoked execution and backfills its interrupted result", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-late-terminal-"))) - 1]!; const store = new ControlPlaneStore(root); await store.initialize(); const now = new Date().toISOString();
    const base = { id: "LATE-TERMINAL-1", projectId: null, status: "failed" as const, specPath: "/tmp/spec", artifactRoot: "/tmp/artifacts", authority: defaultAuthority(undefined), publicationRequested: "none" as const, publicationGate: { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" }, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, error: "late failure", decisions: [], events: [], progress: { phase: "validation", operation: "execution", startedAt: now, updatedAt: now, lastHeartbeatAt: now, executionId: "revoked-worker", attempt: 1, workerStatus: "failed" as const, timeoutMs: 300000, deadlineAt: now, summary: "late failure", diagnostic: "late failure" }, recovery: { reason: "worker_failed", lastPhase: "validation", lastHeartbeatAt: now, originalExecutionId: "revoked-worker", actions: ["start_new_task"], retryAvailable: false, cleanupStatus: "completed" as const }, execution: { attempt: 1, lease: { executionId: "revoked-worker", attempt: 1, operation: "execution" as const, state: "finished" as const, startedAt: now, revokedAt: null, cleanupDeadlineAt: null }, attempts: [], lastRetry: null }, continuation: { schemaVersion: 1 as const, state: "none" as const, decisionId: null, executionId: null, sourceExecutionId: null } };
    await store.saveTask(base); await store.appendEvent(base.id, { at: now, type: "task_interrupted", detail: "execution_deadline_exceeded", executionId: "revoked-worker" }); await store.appendEvent(base.id, { at: now, type: "task_failed", detail: "late failure", executionId: "revoked-worker" }); await new ControlPlaneStore(root).initialize(); expect(await store.getTask(base.id)).toMatchObject({ status: "interrupted", recovery: { reason: "execution_deadline_exceeded", retryAvailable: true }, execution: { lease: { state: "revoked" } } }); expect(await store.readPublishedResult(base.id)).toMatchObject({ executionId: "revoked-worker", result: { status: "interrupted", interruption: { reason: "execution_deadline_exceeded" } } });
    const replacement = structuredClone(base) as unknown as ControlTaskRecord; replacement.id = "LATE-TERMINAL-REPLACED-1"; replacement.status = "completed"; replacement.progress.executionId = "replacement-worker"; replacement.progress.workerStatus = "finished"; replacement.execution.lease!.executionId = "replacement-worker"; replacement.execution.lease!.state = "finished"; replacement.recovery = null; await store.saveTask(replacement); await store.appendEvent(replacement.id, { at: now, type: "task_interrupted", detail: "execution_deadline_exceeded", executionId: "revoked-worker" }); await store.appendEvent(replacement.id, { at: now, type: "retry_requested", executionId: "replacement-worker" }); await store.appendEvent(replacement.id, { at: now, type: "task_started", executionId: "replacement-worker" }); await store.appendEvent(replacement.id, { at: now, type: "task_failed", detail: "late old failure", executionId: "revoked-worker" }); await store.appendEvent(replacement.id, { at: now, type: "task_completed", executionId: "replacement-worker" }); await new ControlPlaneStore(root).initialize(); expect(await store.getTask(replacement.id)).toMatchObject({ status: "completed", progress: { executionId: "replacement-worker" }, execution: { lease: { state: "finished" } } }); expect(await store.readPublishedResult(replacement.id)).toBeNull();
  });
});
