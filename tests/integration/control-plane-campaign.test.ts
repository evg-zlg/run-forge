import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { startControlPlaneServer, type ControlPlaneServerInstance } from "../../src/control-plane/server.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import type { CampaignPlan, ControlTaskRecord } from "../../src/control-plane/contracts.js";
import { planCampaignFromGoal } from "../../src/run/task-run-planner.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

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
    (manager as any).getTask = async (id: string) => tasks.get(id) ?? fakeTask(id, "failed", "missing");
    (manager as any).getResult = async () => ({ usage: { totalTokens: 10, costUsd: 0.01 }, checkpoints: [] });
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Implement one bounded refactor", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 1000, maxTasks: 3, maxConcurrency: 2 } }) });
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
    (manager as any).getResult = async () => ({ usage: { totalTokens: 30, costUsd: 3 } });
    const response = await fetch(`${server.url}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Do independent tasks", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "local" }, limits: { maxTokens: 50, maxCostUsd: 5, maxTasks: 5, maxConcurrency: 2 } }) });
    const campaign = await response.json();
    const final = await waitForCampaign(server, campaign.id);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(final.status).toBe("failed");
    expect(final.failures.some((item: any) => item.reason === "campaign_budget_exceeded")).toBe(true);
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
    (managerA as any).getTask = async (id: string) => statuses.get(id) ?? fakeTask(id, "failed");
    (managerA as any).getResult = async () => ({ usage: { totalTokens: 5, costUsd: 0.1 } });
    const created = await managerA.createCampaign({ goal: "OpenRouter-only run", target: { repository: process.cwd(), workingDirectory: "." }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "openrouter/auto", fallbackPolicy: "none" }, limits: { maxTokens: 1000, maxTasks: 2, maxConcurrency: 1 } });
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
  });
});
