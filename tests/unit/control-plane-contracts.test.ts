import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAuthority, parseDecisionRequest, parseTaskRequest, type ControlTaskRecord } from "../../src/control-plane/contracts.js";
import { assertAgreementMatchesTask, executionAgreementCapabilities, negotiateControlPlaneAgreement, negotiateTaskAgreement, parseExecutionAgreementNegotiationRequest, technicalCapabilitiesForExecutor } from "../../src/control-plane/execution-agreements.js";
import { boundPublicResult, projectAgreementLifecycle, redactPublicValue } from "../../src/control-plane/manager.js";
import { boundPublicResult as extractedBoundPublicResult, projectAgreementLifecycle as extractedProjectAgreementLifecycle, redactPublicValue as extractedRedactPublicValue } from "../../src/control-plane/manager-results.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import type { TaskSpecV2 } from "../../src/product/task-spec-v2.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("control-plane contracts", () => {
  it("preserves manager result helper exports after extraction", () => {
    expect(boundPublicResult).toBe(extractedBoundPublicResult);
    expect(projectAgreementLifecycle).toBe(extractedProjectAgreementLifecycle);
    expect(redactPublicValue).toBe(extractedRedactPublicValue);
  });

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

  it("rejects credential-shaped negotiation material without echoing it", () => {
    const githubToken = ["gh", "p_", "a".repeat(24)].join("");
    const gitlabToken = ["gl", "pat-", "b".repeat(24)].join("");
    const bearerToken = ["Bear", "er ", "c".repeat(24)].join("");
    for (const input of [
      { schemaVersion: 1, profile: "assist-only", ["api" + "Token"]: githubToken },
      { schemaVersion: 1, profile: "custom", prerequisites: { taskAnalysis: [gitlabToken] } },
      { schemaVersion: 1, profile: "custom", completionEvidence: { taskAnalysis: [bearerToken] } },
    ]) {
      let thrown: unknown;
      try { parseExecutionAgreementNegotiationRequest(input); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "credential_material_forbidden" });
      expect(String((thrown as Error).message)).not.toContain(githubToken);
      expect(String((thrown as Error).message)).not.toContain(gitlabToken);
      expect(String((thrown as Error).message)).not.toContain(bearerToken);
    }
  });

  it("treats standalone authority as an explicit per-phase allowlist", () => {
    const omitted = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "assist-only" }));
    expect(omitted).toMatchObject({ status: "conflicted" });
    expect(omitted.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "projectDiscovery", kind: "unauthorized" }),
      expect.objectContaining({ phaseId: "taskAnalysis", kind: "unauthorized" }),
    ]));

    const explicit = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({
      schemaVersion: 1,
      profile: "custom",
      requestedOwnership: { taskAnalysis: "runforge", localValidation: "external_session", prReview: "owner", deploy: "external_system" },
      authority: { taskAnalysis: true },
    }));
    expect(explicit).toMatchObject({
      status: "ready",
      conflicts: [],
      handoffs: [
        { phaseId: "localValidation", responsibleParty: "external_session" },
        { phaseId: "prReview", responsibleParty: "owner" },
        { phaseId: "deploy", responsibleParty: "external_system" },
      ],
    });
    expect(explicit.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "taskAnalysis", authorized: true, status: "ready" }),
      expect.objectContaining({ phaseId: "localValidation", authorized: false, status: "handoff" }),
    ]));

    const unavailable = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({
      schemaVersion: 1,
      profile: "custom",
      requestedOwnership: { deploy: "runforge" },
      technicalCapability: { deploy: true },
      authority: { deploy: true },
    }));
    expect(unavailable).toMatchObject({ status: "conflicted", conflicts: [{ phaseId: "deploy", kind: "unavailable" }] });
    expect(unavailable.phases).toContainEqual(expect.objectContaining({ phaseId: "deploy", available: false, authorized: true, status: "conflict" }));
  });

  it("advertises a ready minimal negotiation request and fails closed when required authority is removed", () => {
    const minimalRequest = executionAgreementCapabilities().minimalRequest;
    const accepted = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest(minimalRequest));
    expect(accepted).toMatchObject({ profile: "assist-only", status: "ready", conflicts: [] });

    const missingAuthority = structuredClone(minimalRequest) as { authority: Record<string, boolean> };
    delete missingAuthority.authority.implementationPlanning;
    const conflicted = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest(missingAuthority));
    expect(conflicted).toMatchObject({
      status: "conflicted",
      conflicts: [{ phaseId: "implementationPlanning", kind: "unauthorized" }],
    });
  });

  it("stores agreements durably and retrieves them after store restart", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-agreement-store-"))) - 1]!;
    const first = new ControlPlaneStore(root); await first.initialize();
    const agreement = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "assist-only" }));
    await first.saveAgreement(agreement);
    const restarted = new ControlPlaneStore(root); await restarted.initialize();
    expect(await restarted.getAgreement(agreement.agreementId)).toEqual(agreement);
  });

  it("strictly parses publication targets and never lets request maps enable degraded installation capability", () => {
    expect(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", publicationTarget: { kind: "existing_branch", branchName: "release/1" } })).toMatchObject({ publicationTarget: { kind: "existing_branch", branchName: "release/1" } });
    expect(() => parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", publicationTarget: { kind: "none", branchName: "not-allowed" } })).toThrow("unknown field");
    const degraded = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", requestedOwnership: { implementation: "runforge" }, technicalCapability: { implementation: true } }), technicalCapabilitiesForExecutor(false));
    expect(degraded).toMatchObject({ status: "conflicted", conflicts: [{ phaseId: "implementation", kind: "unavailable" }] });
  });

  it("conflicts unsupported existing-change publication owned by RunForge and hands off external management", () => {
    const owned = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", publicationTarget: { kind: "existing_change", provider: "github", changeId: "42" }, requestedOwnership: { draftPublication: "runforge" }, technicalCapability: { draftPublication: true } }));
    expect(owned.conflicts).toContainEqual(expect.objectContaining({ phaseId: "draftPublication", kind: "unavailable" }));
    const delegated = negotiateControlPlaneAgreement(parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile: "custom", publicationTarget: { kind: "externally_managed_existing_change", provider: "gitlab", changeId: "9", responsibleParty: "external_session" } }));
    expect(delegated.conflicts).toEqual([]);
    expect(delegated.handoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "remotePush", responsibleParty: "external_session" }),
      expect.objectContaining({ phaseId: "draftPublication", responsibleParty: "external_session" }),
    ]));
  });

  it.each(["draft-pr", "delivery"] as const)("does not silently downgrade the %s profile when publicationTarget is none", (profile) => {
    const agreement = negotiateControlPlaneAgreement(
      parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile, publicationTarget: { kind: "none" } }),
      technicalCapabilitiesForExecutor(true),
    );
    expect(agreement.status).toBe("conflicted");
    expect(agreement.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "remotePush", kind: "unavailable" }),
      expect.objectContaining({ phaseId: "draftPublication", kind: "unavailable" }),
      expect.objectContaining({ phaseId: "ciMonitoring", kind: "unavailable" }),
      expect.objectContaining({ phaseId: "ciRepair", kind: "unavailable" }),
    ]));
  });

  it.each(["assist-only", "local-ready"] as const)("matches a referenced %s task without re-requesting phases suppressed by its none target", (profile) => {
    const context = {
      project: null,
      policy: { sources: ["installation"], hardBoundaries: [], runforgeMd: { present: false, path: null, authorityEscalationTrusted: false as const } },
      publicationTarget: { kind: "none" as const },
    };
    const agreement = negotiateControlPlaneAgreement(
      parseExecutionAgreementNegotiationRequest({ schemaVersion: 1, profile, publicationTarget: { kind: "none" }, authority: localReadyAuthority() }),
      technicalCapabilitiesForExecutor(true),
      context,
    );
    const spec = {
      taskId: `${profile.toUpperCase()}-REFERENCE-1`,
      execution: { mode: "implementation" },
      executionAgreement: { schemaVersion: 1, profile },
      authority: { allowProviderCalls: true },
    } as TaskSpecV2;
    const authority = defaultAuthority({ implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true });
    expect(() => assertAgreementMatchesTask(agreement, spec, negotiateTaskAgreement(spec, authority))).not.toThrow();
  });

  it("matches an auto-negotiated agreement against its own preflight identity", () => {
    const spec = {
      taskId: "AUTO-AGREEMENT-1",
      execution: { mode: "implementation" },
      executionAgreement: { schemaVersion: 1, profile: "local-ready" },
      authority: { allowProviderCalls: true },
    } as TaskSpecV2;
    const authority = defaultAuthority({ implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true });
    const agreement = negotiateTaskAgreement(spec, authority, {
      project: null,
      policy: { sources: ["installation"], hardBoundaries: [], runforgeMd: { present: false, path: null, authorityEscalationTrusted: false } },
      publicationTarget: { kind: "none" },
    });
    expect(agreement.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "remotePush", requested: true, responsibleParty: "external_session" }),
    ]));
    const identicalExpected = structuredClone(agreement);
    expect(identicalExpected.agreementId).toBe(agreement.agreementId);
    expect(() => assertAgreementMatchesTask(agreement, spec, identicalExpected)).not.toThrow();

    const mismatched = structuredClone(agreement);
    const remotePush = mismatched.phases.find((phase) => phase.phaseId === "remotePush");
    if (!remotePush) throw new Error("remotePush phase missing from agreement");
    remotePush.requested = false; remotePush.responsibleParty = "nobody";
    expect(() => assertAgreementMatchesTask(mismatched, spec, identicalExpected)).toThrow("does not match the TaskSpec");
  });

  it("bounds verbose public diagnostics while retaining compact result fields", () => {
    const bounded = boundPublicResult({ status: "awaiting_external_session", providerCalls: [{ stdout: "x".repeat(2_000_000), stderr: "", stdoutArtifact: "provider/iteration-0.stdout.log" }] });
    expect(bounded.result).toMatchObject({ status: "awaiting_external_session", providerCalls: [{ stdoutArtifact: "provider/iteration-0.stdout.log" }] });
    expect(JSON.stringify(bounded.result).length).toBeLessThan(20_000);
    expect(bounded.truncatedFields).toEqual(["providerCalls.0.stdout"]);
  });

  it("redacts token families and absolute paths while preserving relative Git branch refs", () => {
    const githubToken = ["gh", "o_", "d".repeat(24)].join("");
    const gitlabToken = ["gl", "pat-", "e".repeat(24)].join("");
    const bearerToken = ["Bear", "er ", "f".repeat(24)].join("");
    const internalPath = ["/pri", "vate/tmp/runforge/private.log"].join("");
    const branch = "runforge/task/slug-attempt-1";
    const redacted = redactPublicValue({ message: `${githubToken} ${gitlabToken} ${bearerToken} ${internalPath} ${branch}` });
    const publicText = JSON.stringify(redacted);
    for (const sensitive of [githubToken, gitlabToken, bearerToken, internalPath]) expect(publicText).not.toContain(sensitive);
    expect(publicText).toContain("[REDACTED_TOKEN]");
    expect(publicText).toContain("[internal path]");
    expect(publicText).toContain(branch);
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

function localReadyAuthority(): Record<string, boolean> {
  return Object.fromEntries([
    "projectDiscovery", "taskAnalysis", "implementationPlanning", "implementation", "localValidation", "independentReview",
    "repairIterations", "patchPackage", "localBranch", "localCommit", "providerModelCalls",
  ].map((phase) => [phase, true]));
}
