import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAuthority, parseDecisionRequest, parseTaskRequest } from "../../src/control-plane/contracts.js";
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

  it("recovers in-flight state as interrupted without inferring success", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-control-store-"))) - 1]!;
    const store = new ControlPlaneStore(root); await store.initialize();
    const now = new Date().toISOString();
    await store.saveTask({ id: "RECOVERY-1", projectId: null, status: "running", specPath: "/tmp/spec", artifactRoot: "/tmp/artifacts", authority: defaultAuthority(undefined), publicationRequested: "none", publicationGate: { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" }, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, error: null, decisions: [], events: [], progress: { phase: "execution", operation: "execution", startedAt: now, updatedAt: now, lastHeartbeatAt: now, executionId: "old-worker", workerStatus: "active", timeoutMs: 300000, deadlineAt: null, summary: "active", diagnostic: null }, recovery: null, continuation: { schemaVersion: 1, state: "none", decisionId: null, executionId: null } });
    await new ControlPlaneStore(root).initialize();
    expect(await store.getTask("RECOVERY-1")).toMatchObject({ status: "interrupted", ownerGate: { required: true, status: "awaiting_owner_decision" } });
  });
});
