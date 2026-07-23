import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { startControlPlaneServer, type ControlPlaneServerInstance } from "../../src/control-plane/server.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import type { CampaignPlan, ControlTaskRecord } from "../../src/control-plane/contracts.js";
import { planCampaignFromGoal } from "../../src/run/task-run-planner.js";

const cleanup: Array<() => Promise<void>> = [];
const defaultPricing = JSON.stringify({ "qwen/qwen3-coder-next": { inputUsdPerToken: .00000001, outputUsdPerToken: .000001 } });
let previousPricing: string | undefined;
beforeEach(() => { previousPricing = process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON; process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = defaultPricing; });
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  if (previousPricing === undefined) delete process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON; else process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = previousPricing;
});

function fakeTask(id: string, status: ControlTaskRecord["status"], error: string | null = null): ControlTaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    projectId: null,
    status,
    specPath: "",
    artifactRoot: "",
    authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false },
    publicationRequested: "none",
    publicationGate: { required: false, status: "not_requested" },
    ownerGate: { required: false, status: "not_required" },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: status === "completed" || status === "failed" ? now : null,
    error,
    decisions: [],
    events: [],
    progress: { phase: "task_execution", operation: "execution", startedAt: now, updatedAt: now, lastHeartbeatAt: now, executionId: id, attempt: 1, workerStatus: status === "completed" ? "finished" : status === "failed" ? "failed" : "active", timeoutMs: 60_000, deadlineAt: null, summary: status, diagnostic: error },
    recovery: null,
    execution: { attempt: 1, lease: null, attempts: [], lastRetry: null },
    continuation: { schemaVersion: 1, state: "none", decisionId: null, executionId: null, sourceExecutionId: null }
  };
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "runforge-campaign-"));
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
  const manager = new ControlPlaneManager(new ControlPlaneStore(root));
  await manager.initialize();
  const server = await startControlPlaneServer({ host: "127.0.0.1", port: 0, manager });
  cleanup.push(async () => { await server.close(); });
  return { root, manager, server };
}

async function waitForCampaign(instance: ControlPlaneServerInstance, id: string, terminal: Array<string> = ["completed", "failed", "on_hold"]): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${instance.url}/v1/campaigns/${id}`);
    const payload = await response.json();
    if (terminal.includes(payload.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("campaign did not reach terminal status");
}

describe("control plane campaign integration", () => {
  test("one-goal submission internally decomposes and schedules children", async () => {
    const { server, manager } = await createHarness();
    const tasks = new Map<string, ControlTaskRecord>();
    let created = 0;
    (manager as any).planCampaign = async (record: any) => {
      const plan = planCampaignFromGoal(record.id, record.spec);
      plan.nodes.forEach((node) => { node.estimatedTokens = 10; });
      plan.estimatedTokens = plan.nodes.length * 10;
      return { plan, evidence: { mode: "semantic-openrouter", model: "test-planner", attempts: 1, repaired: false, usage: { tokens: 7, costUsd: .002 }, validationCodes: [] } };
    };
    (manager as any).createTask = async (input: any) => {
      created += 1;
      const id = `child-${created}`;
      tasks.set(id, fakeTask(id, "running"));
      setTimeout(() => tasks.set(id, fakeTask(id, "completed")), 20);
      return fakeTask(id, "queued");
    };
    (manager as any).getTask = async (id: string) => { const task = tasks.get(id); if (!task) throw new Error("task not found"); return task; };
    (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 10, costUsd: 0.01 }, checkpoints: [] });
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Inspect one bounded refactor", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 1000, maxTasks: 3, maxConcurrency: 2 } }) });
    expect(response.status).toBe(202);
    const campaign = await response.json();
    const final = await waitForCampaign(server, campaign.id);
    expect(final.status).toBe("completed");
    expect(created).toBeGreaterThan(0);
    expect(Object.values(final.children).every((child: any) => child.status === "completed")).toBe(true);
    expect(final.usage.tokens).toBe(7 + created * 10);
    expect(final.plannerEvidence).toMatchObject({ model: "test-planner", usage: { tokens: 7, costUsd: .002 } });
  });

  test("bounded parallelism and budget overflow propagation", async () => {
    const { server, manager } = await createHarness();
    const statuses = new Map<string, ControlTaskRecord>();
    let concurrent = 0;
    let maxConcurrent = 0;
    let n = 0;
    (manager as any).planCampaign = async (record: any): Promise<CampaignPlan> => ({
      schemaVersion: 1,
      campaignId: record.id,
      estimatedTokens: 60,
      estimatedCostUsd: 6,
      nodes: [1, 2, 3].map((i) => ({ id: `n${i}`, dependsOn: [], estimatedTokens: 20, estimatedCostUsd: 2, taskSpec: { schemaVersion: 2, taskId: `${record.id}_n${i}`, task: { text: "x", goal: "x", acceptanceCriteria: ["x"] }, target: { repository: process.cwd(), workingDirectory: "." }, execution: { mode: "inspection", maxRepairIterations: 0, timeoutMs: 20_000, maxChangedFiles: 1, maxPatchBytes: 1_000, maxProviderTokens: 1_000, budgetMode: "hard", phaseBudgets: { startup: 10, analysis: 10, implementation: 10, validation: 10, repair: 10, review: 10, publication: 0 } }, providerRouting: { provider: "local" }, authority: { profile: "read-only", envelopeFile: null, forbiddenAreas: [], allowProviderCalls: false, allowNetwork: false }, runtime: { preference: "local-disposable", dockerImage: "runforge:local", dependencyPreparation: "if-needed", externalNetwork: "denied" }, validation: { mode: "auto", commands: [], requirements: [] }, discovery: { policy: "auto", profile: "small-scope", explicitFiles: [], maxFiles: 1, maxBytes: 1000, maxTokens: 1000, stopCondition: "x" }, git: { publication: "none", branch: null }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: `/tmp/${record.id}_${i}`, resultFormat: "normalized-v1" }, ownerGate: { policy: "stop-and-report" }, repair: { mode: "none", plan: null } } }))
    });
    (manager as any).createTask = async () => {
      const id = `task-${++n}`;
      statuses.set(id, fakeTask(id, "running"));
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => { statuses.set(id, fakeTask(id, "completed")); concurrent -= 1; }, 25);
      return fakeTask(id, "running");
    };
    (manager as any).getTask = async (id: string) => statuses.get(id) ?? fakeTask(id, "failed");
    (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 30, costUsd: 3 } });
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Do independent tasks", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 50, maxCostUsd: 5, maxTasks: 5, maxConcurrency: 2 } }) });
    const campaign = await response.json();
    const final = await waitForCampaign(server, campaign.id);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(final.status).toBe("failed");
    expect(final.failures.some((item: any) => item.reason === "campaign_budget_exceeded")).toBe(true);
  });

  test("task scheduling rejection fails only the campaign", async () => {
    const { server, manager } = await createHarness();
    (manager as any).planCampaign = async (record: any) => {
      const plan = planCampaignFromGoal(record.id, record.spec);
      plan.nodes.forEach((node) => { node.estimatedTokens = 10; });
      plan.estimatedTokens = plan.nodes.length * 10;
      return plan;
    };
    (manager as any).createTask = async () => { throw new Error("invalid generated child spec"); };
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Inspect one bounded concern", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 1000, maxTasks: 3, maxConcurrency: 1 } }) });
    const campaign = await response.json();
    const final = await waitForCampaign(server, campaign.id);
    expect(final.status).toBe("failed");
    expect(final.failures).toContainEqual(expect.objectContaining({ reason: "campaign_internal_error" }));
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
  });

  test("restart recovery, authority non-expansion and openrouter no-local-fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-restart-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const managerA = new ControlPlaneManager(new ControlPlaneStore(root));
    await managerA.initialize();
    (managerA as any).planCampaign = async (record: any) => ({ plan: planCampaignFromGoal(record.id, record.spec), evidence: { mode: "semantic-openrouter", model: "test-planner", attempts: 1, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: [] } });
    const statuses = new Map<string, ControlTaskRecord>();
    let i = 0;
    (managerA as any).createTask = async (input: any) => {
      expect(input.taskSpec.providerRouting.provider).toBe("openrouter");
      expect(input.taskSpec.providerRouting.fallbackPolicy).toBe("none");
      const id = `recovery-${++i}`;
      statuses.set(id, fakeTask(id, "running"));
      setTimeout(() => statuses.set(id, fakeTask(id, "completed")), 20);
      return fakeTask(id, "running");
    };
    (managerA as any).getTask = async (id: string) => { const task = statuses.get(id); if (!task) throw new Error("task not found"); return task; };
    (managerA as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 5, costUsd: 0.1 } });
    const created = await managerA.createCampaign({ goal: "OpenRouter-only run", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "openrouter/auto", fallbackPolicy: "none" }, limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 } });
    await managerA.drain();
    const managerB = new ControlPlaneManager(new ControlPlaneStore(root));
    await managerB.initialize();
    (managerB as any).createTask = (managerA as any).createTask;
    (managerB as any).getTask = (managerA as any).getTask;
    (managerB as any).getResult = (managerA as any).getResult;
    const deadline = Date.now() + 5_000;
    let final: any = null;
    while (Date.now() < deadline) { final = await managerB.getCampaign(created.id); if (["completed", "failed", "on_hold"].includes(final.status)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(final.status).toBe("completed");
    await expect(managerB.createCampaign({ goal: "Reject authority expansion", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: true, providerCalls: false, network: false, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 } })).rejects.toThrow(/authority expansion/i);
    await managerB.drain();
  });

  test("enforces one active campaign coordinator per state root and releases ownership on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-singleton-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const managerA = new ControlPlaneManager(new ControlPlaneStore(root));
    const managerB = new ControlPlaneManager(new ControlPlaneStore(root));
    await managerA.initialize();
    await expect(managerB.initialize()).rejects.toMatchObject({ status: 409, code: "campaign_coordinator_already_active" });
    await managerA.drain();
    await managerB.initialize();
    await managerB.drain();
  });

  test("server shutdown rejects reactivation and holds the lease through in-flight planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-http-drain-")); cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const managerA = new ControlPlaneManager(new ControlPlaneStore(root)); await managerA.initialize();
    const instance = await startControlPlaneServer({ host: "127.0.0.1", port: 0, manager: managerA });
    let releasePlanning!: () => void, planningStarted!: () => void;
    const started = new Promise<void>((resolve) => { planningStarted = resolve; });
    (managerA as any).planCampaign = async (record: any) => { planningStarted(); await new Promise<void>((resolve) => { releasePlanning = resolve; }); return planCampaignFromGoal(record.id, record.spec); };
    const input = { goal: "Inspect during shutdown", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" as const }, limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 } };
    const request = fetch(`${instance.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    await started; const closing = instance.close();
    await expect(managerA.createCampaign(input)).rejects.toMatchObject({ code: "campaign_coordinator_closed" });
    const managerB = new ControlPlaneManager(new ControlPlaneStore(root));
    await expect(managerB.initialize()).rejects.toMatchObject({ code: "campaign_coordinator_already_active" });
    await expect(fetch(`${instance.url}/readyz`)).rejects.toThrow();
    releasePlanning(); expect((await request).status).toBe(409); await closing;
    await managerB.initialize(); await managerB.drain();
  });

  test("holds implementation campaigns when the project validation contract is unknown", async () => {
    const { manager } = await createHarness();
    const campaign = await manager.createCampaign({
      goal: "Change one bounded implementation detail",
      target: { repository: process.cwd(), workingDirectory: "." },
      authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false },
      providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" },
      limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 },
    });
    expect(campaign.status).toBe("on_hold");
    expect(campaign.failures).toContainEqual(expect.objectContaining({ reason: "campaign_validation_contract_unknown" }));
    expect(campaign.result).toMatchObject({ status: "on_hold", validation: { contract: { status: "unknown" }, completion: "blocked" } });
  });

  test("rejects a local implementation bypass", async () => {
    const { manager } = await createHarness();
    await expect(manager.createCampaign({
      goal: "Bypass isolated integration",
      target: { repository: process.cwd(), workingDirectory: "." },
      authority: { inspect: true, implementation: true, providerCalls: true, network: false, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false },
      providerRouting: { provider: "local" }, limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 },
      validationContract: { source: "explicit", requiredCommands: ["corepack pnpm test"] },
    })).rejects.toThrow(/Local implementation campaigns are disabled/);
  });

  test("holds a campaign when a completed child still reports an external workflow handoff", async () => {
    const { manager } = await createHarness();
    (manager as any).planCampaign = async (record: any) => ({
      schemaVersion: 1, campaignId: record.id, estimatedTokens: 1_000,
      nodes: [{ id: "inspect", dependsOn: [], estimatedTokens: 1_000, taskSpec: { schemaVersion: 2, taskId: `${record.id}_inspect`, task: { text: "inspect", goal: "inspect", acceptanceCriteria: ["evidence"] }, target: { repository: process.cwd(), workingDirectory: "." }, execution: { mode: "inspection" }, providerRouting: { provider: "local" }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false }, runtime: { preference: "local-disposable" }, validation: { mode: "auto", commands: [], requirements: [] }, discovery: { policy: "auto", explicitFiles: [] }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, ownerGate: { policy: "stop-and-report" }, repair: { mode: "none", plan: null }, artifacts: { root: "/tmp/unused", resultFormat: "normalized-v1" } } }],
    });
    (manager as any).createTask = async () => fakeTask("handoff-child", "completed");
    (manager as any).getTask = async () => fakeTask("handoff-child", "completed");
    (manager as any).getResult = async () => ({ status: "awaiting_external_session", workflowCompleted: false, nextAction: { party: "external_session" } });
    const campaign = await manager.createCampaign({
      goal: "Inspect and report", target: { repository: process.cwd(), workingDirectory: "." },
      authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false },
      providerRouting: { provider: "local" }, limits: { maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 },
    });
    const deadline = Date.now() + 5_000;
    let final: any = campaign;
    while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
    expect(final).toMatchObject({ status: "on_hold", children: { inspect: { status: "blocked", error: "campaign_child_workflow_incomplete:awaiting_external_session" } } });
  });

  test("rejects OpenRouter authority and target gaps before semantic planning", async () => {
    const { manager } = await createHarness();
    let plannerCalls = 0;
    (manager as any).planCampaign = async () => { plannerCalls += 1; throw new Error("planner must not run"); };
    await expect(manager.createCampaign({ goal: "Inspect", target: { repository: process.cwd() }, authority: { inspect: true, implementation: false, providerCalls: false, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 } })).rejects.toThrow(/providerCalls and network authority/);
    await expect(manager.createCampaign({ goal: "Inspect", target: { repository: process.cwd() }, authority: { inspect: true, implementation: false, providerCalls: true, network: false, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 } })).rejects.toThrow(/providerCalls and network authority/);
    await expect(manager.createCampaign({ goal: "Implement", target: {}, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } })).rejects.toThrow(/explicit target\.repository/);
    expect(plannerCalls).toBe(0);
  });

  test("publishes valid trusted-pricing readiness without exposing rates", async () => {
    process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = JSON.stringify({ "qwen/qwen3-coder-next": { inputUsdPerToken: .123456789, outputUsdPerToken: .987654321 } });
    const { server } = await createHarness();
    const response = await fetch(`${server.url}/v1/capabilities`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ providerRouting: { providers: { openrouter: { pricingCatalog: { configured: true, catalogValid: true, code: "ready", message: expect.stringContaining("exact quote") } } } } });
    expect(payload.providerRouting.providers.openrouter.pricingCatalog.cappedCampaignsReady).toBeUndefined();
    const ready = await fetch(`${server.url}/readyz`).then((item) => item.json());
    expect(ready).toMatchObject({ service: { status: "healthy" }, readiness: { acceptingNewTasks: true, openrouter: { pricingCatalog: { configured: true, catalogValid: true, code: "ready" } } } });
    expect(JSON.stringify(payload)).not.toContain(".123456789");
    expect(JSON.stringify(payload)).not.toContain(".987654321");
    expect(JSON.stringify(ready)).not.toContain(".123456789");
  });

  test("publishes missing and empty catalog limitations without degrading general task readiness", async () => {
    delete process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON;
    const { server } = await createHarness();
    const missing = await fetch(`${server.url}/readyz`).then((item) => item.json());
    expect(missing).toMatchObject({ service: { status: "healthy" }, readiness: { acceptingNewTasks: true, openrouter: { pricingCatalog: { configured: false, catalogValid: false, code: "not_configured", message: expect.stringContaining("require RUNFORGE_OPENROUTER_MODEL_PRICING_JSON") } } } });

    process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = "{}";
    const empty = await fetch(`${server.url}/readyz`).then((item) => item.json());
    expect(empty).toMatchObject({ readiness: { acceptingNewTasks: true, openrouter: { pricingCatalog: { configured: true, catalogValid: false, code: "empty", message: expect.stringContaining("no trusted model quotes") } } } });
    expect(empty.readiness.openrouter.pricingCatalog.cappedCampaignsReady).toBeUndefined();
    const rejected = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Inspect a bounded change", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: true, network: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxCostUsd: 1, maxTasks: 1, maxConcurrency: 1 } }) });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: { code: "openrouter_pricing_catalog_invalid", message: expect.stringContaining("no trusted model quotes") } });
  });

  test("rejects malformed capped-campaign pricing synchronously but preserves uncapped compatibility", async () => {
    process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = "{not-json";
    const { server, manager } = await createHarness();
    let plannerCalls = 0;
    (manager as any).planCampaign = async () => { plannerCalls += 1; throw new Error("planner transport placeholder"); };
    const base = { goal: "Inspect a bounded change", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: true, network: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxTasks: 1, maxConcurrency: 1 } };
    const readiness = await fetch(`${server.url}/readyz`).then((item) => item.json());
    expect(readiness).toMatchObject({ readiness: { acceptingNewTasks: true, openrouter: { pricingCatalog: { configured: true, catalogValid: false, code: "invalid", message: expect.stringContaining("not valid JSON") } } } });
    const capped = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, limits: { ...base.limits, maxCostUsd: 1 } }) });
    expect(capped.status).toBe(422);
    expect(await capped.json()).toMatchObject({ error: { code: "openrouter_pricing_catalog_invalid", message: expect.stringContaining("not valid JSON"), details: { catalog: { configured: true, catalogValid: false }, selectedPlannerModel: "qwen/qwen3-coder-next", selectedModelPricingReady: false } } });
    expect(plannerCalls).toBe(0);

    const uncapped = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) });
    expect(uncapped.status).toBe(202);
    expect((await uncapped.json()).status).toBe("failed");
    expect(plannerCalls).toBe(1);
  });

  test("rejects the exact deterministically selected unquoted model from a multi-model planner pool", async () => {
    process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = JSON.stringify({ "catalogued/other": { inputUsdPerToken: .00000001, outputUsdPerToken: .000001 } });
    const { server, manager } = await createHarness();
    let plannerCalls = 0;
    (manager as any).planCampaign = async () => { plannerCalls += 1; throw new Error("planner must not run"); };
    const models = ["pool/model-a", "pool/model-b"];
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Inspect a bounded change", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: false, providerCalls: true, network: true, localBranch: false, localCommit: false, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", modelPools: { planner: models }, fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxCostUsd: 1, maxTasks: 1, maxConcurrency: 1 } }) });
    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { code: "openrouter_model_pricing_unavailable", message: expect.stringContaining("trusted exact quote"), details: { catalog: { configured: true, catalogValid: true }, selectedPlannerModel: expect.any(String), selectedModelPricingReady: false } } });
    expect(models).toContain(payload.error.details.selectedPlannerModel);
    expect(payload.error.message).toContain(payload.error.details.selectedPlannerModel);
    expect(plannerCalls).toBe(0);
  });

  test("rejects an invalid custom implementation sink before creating its worktree", async () => {
    const { manager } = await createHarness();
    (manager as any).planCampaign = async (record: any) => ({ schemaVersion: 1, campaignId: record.id, estimatedTokens: 1_000, estimatedCostUsd: .1, nodes: [{ id: "unsafe-sink", dependsOn: [], writeScopes: ["src/a.ts"], estimatedTokens: 1_000, estimatedCostUsd: .1, taskSpec: { execution: { mode: "implementation" }, authority: { profile: "bounded-implementation", allowProviderCalls: false, allowNetwork: false }, discovery: { writeScopes: ["src/a.ts"] }, validation: { mode: "explicit", commands: ["node --version", "git diff --check __CAMPAIGN_BASE__...HEAD"] }, providerRouting: { provider: "openrouter", fallbackPolicy: "none", costBudgetUsd: .1 }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } } }] });
    await expect(manager.createCampaign({ goal: "Invalid custom plan", target: { repository: "/definitely/missing/runforge-campaign-repo" }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 2_000, maxCostUsd: 1, maxTasks: 1, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } })).rejects.toThrow(/implementation campaign plan requires|terminal node.*validation-only/i);
  });
});
