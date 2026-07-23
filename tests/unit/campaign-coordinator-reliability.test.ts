import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignCoordinator } from "../../src/control-plane/campaign-coordinator.js";
import { CampaignCoordinatorLease } from "../../src/control-plane/campaign-coordinator-lease.js";
import { campaignChildCompletion } from "../../src/control-plane/campaign-coordinator-state.js";
import type { CampaignPlan, CampaignRecord, CampaignSpec, ControlTaskRecord } from "../../src/control-plane/contracts.js";
import { normalizeTaskSpecV2 } from "../../src/product/task-spec-v2.js";

const roots: string[] = [];
const exec = promisify(execFile);
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
async function initRepository(root: string): Promise<string> { await writeFile(join(root, "README.md"), "fixture\n"); await exec("git", ["init", "-q", "-b", "main"], { cwd: root }); await exec("git", ["add", "README.md"], { cwd: root }); await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "fixture"], { cwd: root }); return (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(); }
function implementationNodeSpec(taskId: string): Record<string, unknown> { return { schemaVersion: 2, taskId, target: {}, task: { text: "implement", goal: "validated implementation", acceptanceCriteria: ["validation passes"] }, discovery: {}, execution: { mode: "implementation", maxProviderTokens: 1_000 }, providerRouting: { provider: "openrouter", fallbackPolicy: "same_provider", models: { implementer: "openai/implementer", logCompression: "openai/compressor" }, modelPools: { logCompression: ["openai/compressor"] }, maxCalls: 1, tokenBudget: { total: 1_000, perPhase: { planner: 0, implementer: 900, repair: 0, reviewer: 0, logCompression: 100 } }, timeoutMs: 10_000, retry: { maxAttempts: 2 } }, validation: { mode: "explicit", commands: ["node --version"] }, authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: false }, runtime: { preference: "local-disposable", dependencyPreparation: "disabled", externalNetwork: "denied" } }; }

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

  it("accepts only the authenticated max-calls delegated-review failure shape", () => {
    const reason = "Semantic reviewer invocation was unavailable: openrouter_max_calls_exceeded";
    const semanticReview = { kind: "semantic", status: "unavailable", performed: false, selectedReviewer: { provider: "openrouter", model: "qwen/qwen3-coder-next" }, reviewer: { provider: null, model: null, invocationId: null }, confidence: "unknown", limitations: [reason], findings: [], evidence: [], delegation: { party: "external_session", reason, exactAction: "Perform an independent semantic review in the delegated session and attach structured findings to this handoff." } };
    const settlement = { status: "completed", actualExecutorMode: "implementation", workflow: { status: "failed", implementationCompleted: true, validationCompleted: true, validationAggregate: "completed_with_validation_gaps", budgetExceeded: false, publicationBlocked: true, ownerDecisionRequired: false, handoff: { semanticReview } }, implementation: { status: "implemented_and_validated" }, validationAggregate: "completed_with_validation_gaps", review: { semantic: structuredClone(semanticReview) }, ownerGate: { required: false }, publication: { status: "on_hold", performed: false } };
    expect(campaignChildCompletion(settlement, "implementation")).toEqual({ completed: true, reason: "" });
    expect(campaignChildCompletion({ ...settlement, review: { semantic: { ...semanticReview, limitations: [] } } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, workflow: { ...settlement.workflow, handoff: { semanticReview: { ...semanticReview, delegation: { ...semanticReview.delegation, party: "owner" } } } } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, review: { semantic: { ...semanticReview, performed: true } } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, workflow: { ...settlement.workflow, validationAggregate: "passed" } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, ownerGate: { required: true } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, workflow: { ...settlement.workflow, budgetExceeded: true } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, workflow: { ...settlement.workflow, ownerDecisionRequired: true } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, workflow: { ...settlement.workflow, ownerGate: { required: true } } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, budget: { exceeded: true } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
    expect(campaignChildCompletion({ ...settlement, publication: { status: "published", performed: true } }, "implementation")).toEqual({ completed: false, reason: "campaign_child_workflow_fatal:failed" });
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

  it("projects a strictly positive logCompression phase budget for normal integrated child dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-logcompression-normal-")); roots.push(root);
    await mkdir(join(root, "campaigns"), { recursive: true }); const head = await initRepository(root);
    const campaignId = "cmp_v1_logcompression_normal";
    const dispatchedSpecs: Record<string, unknown>[] = [];
    const campaign: CampaignRecord = {
      schemaVersion: 1, id: campaignId, status: "queued",
      spec: { ...spec(), authority: { ...authority, implementation: true }, limits: { ...spec().limits, maxTokens: 1_000, maxTasks: 1, maxConcurrency: 1 } },
      plan: { schemaVersion: 1, campaignId, estimatedTokens: 1_000, estimatedCostUsd: .01, nodes: [{ id: "one", dependsOn: [], estimatedTokens: 1_000, estimatedCostUsd: .01, taskSpec: implementationNodeSpec(`${campaignId}-one`) }] },
      plannerEvidence: null,
      integration: { status: "ready", worktreeRoot: root, branch: "cmp/test", baseSha: head, headSha: head, appliedNodes: [], repairAttempts: 0, lastError: null },
      children: { one: { nodeId: "one", dependsOn: [], taskId: `${campaignId}-one`, status: "dispatching", startedAt: null, finishedAt: null, error: null, accounted: false, reservedTokens: 1_000, reservedCostUsd: .01, integrationRepairAttempts: 0, executionRetryAttempts: 0 } },
      usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 1_000, costUsd: .01 }, checkpoints: [], failures: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await writeFile(join(root, "campaigns", `${campaignId}.json`), JSON.stringify(campaign));
    const coordinator = new CampaignCoordinator({
      root,
      planCampaign: async () => { throw new Error("not used"); },
      createTask: async (input) => { const normalized = await normalizeTaskSpecV2(input.taskSpec, root); dispatchedSpecs.push(normalized as unknown as Record<string, unknown>); return task(normalized.taskId, "queued"); },
      getTask: async () => null as unknown as ControlTaskRecord,
      getResult: async () => ({ status: "workflow_completed", usage: { totalTokens: 2, costUsd: .02 } }),
    });
    await coordinator.initialize();
    await waitFor(() => coordinator.getCampaign(campaignId), () => dispatchedSpecs.length === 1);
    expect(dispatchedSpecs).toHaveLength(1);
    const projected = dispatchedSpecs[0] as { providerRouting?: { tokenBudget?: { total?: number; perPhase?: { logCompression?: number } }; routes?: { logCompression?: unknown }; modelPools?: { logCompression?: unknown } } };
    expect(projected.providerRouting?.routes?.logCompression ?? projected.providerRouting?.modelPools?.logCompression).toBeDefined();
    expect(projected.providerRouting?.tokenBudget?.total).toBe(1_000);
    expect(projected.providerRouting?.tokenBudget?.perPhase?.logCompression).toBeGreaterThan(0);
    expect((projected.providerRouting as { maxCalls?: number }).maxCalls).toBeGreaterThanOrEqual(4);
    await coordinator.drain();
  });

  it("projects retry child specs with a strictly positive logCompression phase budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-logcompression-retry-")); roots.push(root);
    await mkdir(join(root, "campaigns"), { recursive: true }); const head = await initRepository(root);
    const campaignId = "cmp_v1_logcompression_retry";
    const dispatchedSpecs: Record<string, unknown>[] = [];
    const campaign: CampaignRecord = {
      schemaVersion: 1, id: campaignId, status: "queued",
      spec: { ...spec(), authority: { ...authority, implementation: true }, limits: { ...spec().limits, maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 } },
      plan: { schemaVersion: 1, campaignId, estimatedTokens: 1_000, estimatedCostUsd: .01, nodes: [{ id: "one", dependsOn: [], estimatedTokens: 1_000, estimatedCostUsd: .01, taskSpec: implementationNodeSpec(`${campaignId}-one`) }] },
      plannerEvidence: null,
      integration: { status: "ready", worktreeRoot: root, branch: "cmp/test", baseSha: head, headSha: head, appliedNodes: [], repairAttempts: 0, lastError: null },
      children: { one: { nodeId: "one", dependsOn: [], taskId: `${campaignId}-one`, status: "dispatching", startedAt: null, finishedAt: null, error: null, accounted: false, reservedTokens: 1_000, reservedCostUsd: .01, integrationRepairAttempts: 0, executionRetryAttempts: 0 } },
      usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 1_000, costUsd: .01 }, checkpoints: [], failures: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await writeFile(join(root, "campaigns", `${campaignId}.json`), JSON.stringify(campaign));
    const taskStatus = new Map<string, ControlTaskRecord["status"]>();
    const coordinator = new CampaignCoordinator({
      root,
      planCampaign: async () => { throw new Error("not used"); },
      createTask: async (input) => {
        const normalized = await normalizeTaskSpecV2(input.taskSpec, root); dispatchedSpecs.push(normalized as unknown as Record<string, unknown>);
        const id = normalized.taskId;
        taskStatus.set(id, "failed");
        return task(id, "queued");
      },
      getTask: async (id) => taskStatus.has(id) ? task(id, taskStatus.get(id)!) : null as unknown as ControlTaskRecord,
      getResult: async () => ({ status: "workflow_completed", usage: { totalTokens: 0, costUsd: 0 } }),
    });
    await coordinator.initialize();
    await waitFor(() => coordinator.getCampaign(campaignId), (value) => value.status === "failed" && dispatchedSpecs.length === 2);
    const normal = dispatchedSpecs[0] as { taskId?: string; providerRouting?: { tokenBudget?: { total?: number; perPhase?: { logCompression?: number } } } };
    const retry = dispatchedSpecs[1] as { taskId?: string; providerRouting?: { tokenBudget?: { total?: number; perPhase?: { logCompression?: number } } } };
    expect(normal.taskId).toBe(`${campaignId}-one`);
    expect(retry.taskId).toContain("_one_er1");
    expect(normal.providerRouting?.tokenBudget?.total).toBe(1_000);
    expect(retry.providerRouting?.tokenBudget?.total).toBe(1_000);
    expect(normal.providerRouting?.tokenBudget?.perPhase?.logCompression).toBeGreaterThan(0);
    expect(retry.providerRouting?.tokenBudget?.perPhase?.logCompression).toBeGreaterThan(0);
    expect((normal.providerRouting as { maxCalls?: number }).maxCalls).toBeGreaterThanOrEqual(4);
    expect((retry.providerRouting as { maxCalls?: number }).maxCalls).toBeGreaterThanOrEqual(4);
    await coordinator.drain();
  });

  it("conserves non-implementation phases and does not retain a zero compression field without a route", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-validation-projection-")); roots.push(root); const head = await initRepository(root), campaignId = "cmp_v1_validation_projection";
    const node = { id: "validate", dependsOn: [], estimatedTokens: 1_000, estimatedCostUsd: 0, taskSpec: { schemaVersion: 2, taskId: `${campaignId}-validate`, target: {}, task: { text: "validate", goal: "validate", acceptanceCriteria: ["validation passes"] }, discovery: {}, execution: { mode: "validation", maxProviderTokens: 1_000 }, providerRouting: { provider: "local", fallbackPolicy: "none", models: {}, maxCalls: 1, tokenBudget: { total: 1_000, perPhase: { planner: 700, implementer: 0, repair: 0, reviewer: 300, logCompression: 0 } }, timeoutMs: 10_000, retry: { maxAttempts: 1 } }, validation: { mode: "explicit", commands: ["node --version"] }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false }, runtime: { preference: "local-disposable", dependencyPreparation: "disabled", externalNetwork: "denied" } } } as CampaignPlan["nodes"][number];
    const campaign = { schemaVersion: 1, id: campaignId, status: "running", spec: { ...spec(), limits: { ...spec().limits, maxTokens: 1_000 } }, plan: { schemaVersion: 1, campaignId, estimatedTokens: 1_000, estimatedCostUsd: 0, nodes: [node] }, integration: { status: "ready", worktreeRoot: root, branch: "cmp/test", baseSha: head, headSha: head, appliedNodes: [], repairAttempts: 0, lastError: null }, children: {}, usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 0, costUsd: 0 }, checkpoints: [], failures: [], result: null, plannerEvidence: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as CampaignRecord;
    const coordinator = new CampaignCoordinator({ root, planCampaign: async () => campaign.plan!, createTask: async () => task("unused", "queued"), getTask: async () => task("unused", "failed"), getResult: async () => ({}) });
    const projected = (coordinator as unknown as { taskSpecForNode(value: CampaignRecord, item: CampaignPlan["nodes"][number]): Record<string, unknown> }).taskSpecForNode(campaign, node), normalized = await normalizeTaskSpecV2(projected, root), phases = normalized.providerRouting.tokenBudget.perPhase;
    expect(phases.logCompression).toBe(0); expect(normalized.providerRouting.models.logCompression).toBeUndefined(); expect(normalized.providerRouting.modelPools?.logCompression).toBeUndefined(); expect(Object.values(phases).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(normalized.providerRouting.tokenBudget.total);
  });
});
