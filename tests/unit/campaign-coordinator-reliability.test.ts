import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignCoordinator } from "../../src/control-plane/campaign-coordinator.js";
import { CampaignCoordinatorLease } from "../../src/control-plane/campaign-coordinator-lease.js";
import { campaignChildCompletion } from "../../src/control-plane/campaign-coordinator-state.js";
import type { CampaignPlan, CampaignRecord, CampaignSpec, ControlTaskRecord } from "../../src/control-plane/contracts.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

const authority = { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false };
function spec(): CampaignSpec { return { goal: "bounded inspection", target: { repository: process.cwd(), workingDirectory: "." }, authority, providerRouting: { provider: "local" }, limits: { maxTokens: 120, maxCostUsd: 2, maxTasks: 3, maxConcurrency: 2 } }; }
function task(id: string, status: ControlTaskRecord["status"]): ControlTaskRecord { return { id, status, error: null } as ControlTaskRecord; }
function plan(id: string): CampaignPlan {
  return {
    schemaVersion: 1, campaignId: id, estimatedTokens: 120, estimatedCostUsd: 1.2,
    nodes: ["one", "two", "three"].map((node) => ({ id: node, dependsOn: [], estimatedTokens: 40, estimatedCostUsd: .4, taskSpec: { taskId: `${id}-${node}`, target: {}, task: {}, discovery: {} } }))
  };
}
async function waitFor(read: () => Promise<CampaignRecord>, predicate: (value: CampaignRecord) => boolean): Promise<CampaignRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("campaign did not reach expected state");
}

describe("CampaignCoordinator reliability", () => {
  it("accepts a completed implementation result despite an external nested review, but keeps validation strict", () => {
    const implementation = { status: "completed", workflow: { status: "awaiting_external_session" }, implementation: { status: "implemented_and_validated" }, validationAggregate: "passed" };
    expect(campaignChildCompletion(implementation, "implementation")).toEqual({ completed: true, reason: "" });
    expect(campaignChildCompletion({ ...implementation, workflow: { status: "failed" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...implementation, workflow: { status: "awaiting_external_session", verdict: "rejected" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_verdict:rejected" });
    expect(campaignChildCompletion({ ...implementation, workflow: undefined }, "implementation")).toEqual({ completed: false, reason: "campaign_child_implementation_workflow_unknown:missing" });
    expect(campaignChildCompletion({ ...implementation, workflow: { status: "mystery" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_implementation_workflow_unknown:mystery" });
    expect(campaignChildCompletion({ ...implementation, validationAggregate: "product_failed" }, "implementation")).toEqual({ completed: false, reason: "campaign_child_implementation_validation_incomplete:product_failed" });
    expect(campaignChildCompletion({ ...implementation, implementation: { status: "failed_with_diagnostics" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_implementation_incomplete:failed_with_diagnostics" });
    expect(campaignChildCompletion({ ...implementation, implementation: { status: "no_change_required" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_implementation_no_change_requires_explicit_noop_contract" });
    expect(campaignChildCompletion({ status: "completed", workflow: { status: "awaiting_external_session" } }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_incomplete:awaiting_external_session" });
    expect(campaignChildCompletion({ status: "completed", workflow: { status: "workflow_completed" }, validationAggregate: "completed_with_validation_gaps" }, "validation")).toEqual({ completed: true, reason: "" });
    expect(campaignChildCompletion({ status: "workflow_completed", workflow: { status: "failed" }, validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ status: "workflow_completed", workflowCompleted: false, validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_incomplete:workflowCompleted_false" });
    expect(campaignChildCompletion({ status: "completed", workflow: { status: "workflow_completed", workflowCompleted: false }, validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_incomplete:workflowCompleted_false" });
    expect(campaignChildCompletion({ status: "workflow_completed", workflow: { status: "awaiting_external_session" }, validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_incomplete:awaiting_external_session" });
    expect(campaignChildCompletion({ status: "rejected", validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:rejected" });
    expect(campaignChildCompletion({ status: "workflow_completed", workflow: { status: "do_not_apply" }, validationAggregate: "passed" }, "validation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:do_not_apply" });
    expect(campaignChildCompletion({ status: "workflow_completed", validationAggregate: "blocked_by_capability" }, "validation")).toEqual({ completed: false, reason: "campaign_child_validation_incomplete:blocked_by_capability" });
  });

  it("persists aggregate reservations and refuses to overschedule after actual usage replaces one reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-reservations-")); roots.push(root);
    const tasks = new Map<string, ControlTaskRecord>();
    let creates = 0;
    const coordinator = new CampaignCoordinator({
      root,
      planCampaign: async (record) => plan(record.id),
      createTask: async (input) => { creates += 1; const created = task(String(input.taskSpec.taskId), "running"); tasks.set(created.id, created); return created; },
      getTask: async (id) => tasks.get(id) ?? Promise.reject(new Error("not found")),
      getResult: async (id) => ({ status: "workflow_completed", usage: { totalTokens: id.endsWith("-one") ? 60 : 40, costUsd: .4 } }),
    });
    const campaign = await coordinator.createCampaign(spec());
    await waitFor(() => coordinator.getCampaign(campaign.id), (value) => creates === 2 && value.reserved.tokens === 80);
    tasks.set(`${campaign.id}-one`, task(`${campaign.id}-one`, "completed"));
    const final = await waitFor(() => coordinator.getCampaign(campaign.id), (value) => value.status === "failed");
    expect(creates).toBe(2);
    expect(final.children.one.reservedTokens).toBe(0);
    expect(final.reserved.tokens).toBe(40);
    expect(final.failures).toContainEqual(expect.objectContaining({ reason: "campaign_budget_exceeded" }));
    await coordinator.drain();
  });

  it("adopts a deterministic task created before a crash instead of dispatching it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-dispatch-recovery-")); roots.push(root);
    await mkdir(join(root, "campaigns"), { recursive: true });
    const campaignId = "cmp_v1_recovery";
    const campaign: CampaignRecord = {
      schemaVersion: 1, id: campaignId, status: "queued", spec: { ...spec(), limits: { ...spec().limits, maxTasks: 1, maxConcurrency: 1 } }, plan: { schemaVersion: 1, campaignId, estimatedTokens: 40, estimatedCostUsd: .4, nodes: [{ id: "one", dependsOn: [], estimatedTokens: 40, estimatedCostUsd: .4, taskSpec: { taskId: `${campaignId}-one`, target: {}, task: {}, discovery: {} } }] }, plannerEvidence: null, integration: null,
      children: { one: { nodeId: "one", dependsOn: [], taskId: `${campaignId}-one`, status: "dispatching", startedAt: new Date().toISOString(), finishedAt: null, error: null, accounted: false, reservedTokens: 40, reservedCostUsd: .4, integrationRepairAttempts: 0, executionRetryAttempts: 0 } },
      usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 40, costUsd: .4 }, checkpoints: [], failures: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await writeFile(join(root, "campaigns", `${campaignId}.json`), JSON.stringify(campaign));
    let creates = 0;
    const coordinator = new CampaignCoordinator({
      root,
      planCampaign: async () => { throw new Error("not used"); },
      createTask: async () => { creates += 1; return task("unexpected", "queued"); },
      getTask: async (id) => id === `${campaignId}-one` ? task(id, "completed") : Promise.reject(new Error("missing")),
      getResult: async () => ({ status: "workflow_completed", usage: { totalTokens: 25, costUsd: .25 } }),
    });
    await coordinator.initialize();
    const completed = await waitFor(() => coordinator.getCampaign(campaignId), (value) => value.status === "completed");
    expect(creates).toBe(0);
    expect(completed.children.one.taskId).toBe(`${campaignId}-one`);
    expect(completed.children.one.reservedTokens).toBe(0);
    expect(completed.reserved).toEqual({ tokens: 0, costUsd: 0 });
    await coordinator.drain();
  });

  it("holds the lease until a deferred dispatch settles and fences its stale binding save", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-drain-barrier-")); roots.push(root);
    let releaseCreate!: () => void, markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const created = new Map<string, ControlTaskRecord>();
    const coordinatorA = new CampaignCoordinator({
      root, planCampaign: async (record) => ({ ...plan(record.id), nodes: [plan(record.id).nodes[0]!], estimatedTokens: 40, estimatedCostUsd: .4 }),
      createTask: async (input) => { markStarted(); await new Promise<void>((resolve) => { releaseCreate = resolve; }); const value = task(String(input.taskSpec.taskId), "completed"); created.set(value.id, value); return value; },
      getTask: async (id) => created.get(id) ?? Promise.reject(new Error("missing")), getResult: async () => ({ status: "workflow_completed", usage: { totalTokens: 25, costUsd: .25 } }),
    });
    const campaign = await coordinatorA.createCampaign({ ...spec(), limits: { ...spec().limits, maxTasks: 1, maxConcurrency: 1 } });
    await started; coordinatorA.close();
    const coordinatorB = new CampaignCoordinator({ root, planCampaign: async () => { throw new Error("not used"); }, createTask: async () => { throw new Error("must reconcile"); }, getTask: async (id) => created.get(id) ?? Promise.reject(new Error("missing")), getResult: async () => ({ status: "workflow_completed", usage: { totalTokens: 25, costUsd: .25 } }) });
    await expect(coordinatorB.initialize()).rejects.toMatchObject({ code: "campaign_coordinator_already_active" });
    releaseCreate(); await coordinatorA.drain();
    expect(await coordinatorA.getCampaign(campaign.id)).toMatchObject({ children: { one: { status: "dispatching" } }, reserved: { tokens: 40 } });
    await coordinatorB.initialize();
    const completed = await waitFor(() => coordinatorB.getCampaign(campaign.id), (value) => value.status === "completed");
    expect(completed.usage.tokens).toBe(25); await coordinatorB.drain();
  });

  it("recovers ownerless and malformed leases only after their mtime grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-stale-lease-")); roots.push(root);
    const lock = join(root, ".campaign-coordinator.lock"), old = new Date(Date.now() - 10_000);
    await mkdir(lock); await utimes(lock, old, old);
    const ownerless = new CampaignCoordinatorLease(root, 1_000); ownerless.acquire(); ownerless.release();
    await mkdir(lock); const owner = join(lock, "owner.json"); await writeFile(owner, "not-json\n"); await utimes(owner, old, old);
    const malformed = new CampaignCoordinatorLease(root, 1_000); malformed.acquire(); malformed.release();
  });
});
