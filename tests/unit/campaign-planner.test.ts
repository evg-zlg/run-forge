import { describe, expect, test } from "vitest";
import { parseCampaignRequest } from "../../src/control-plane/contracts.js";
import { detectCycle, planCampaignFromGoal, topoSortPlan, validateCampaignPlan } from "../../src/run/task-run-planner.js";

const authority = { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false };

describe("campaign planner unit", () => {
  test("one-goal decomposition creates a bounded DAG", () => {
    const spec = parseCampaignRequest({ goal: "Implement a bounded enhancement", target: { repository: process.cwd(), workingDirectory: "." }, authority, providerRouting: { provider: "local" }, limits: { maxTokens: 5000, maxTasks: 3, maxConcurrency: 2 } });
    const plan = planCampaignFromGoal("cmp_v1_deadbeefdeadbeefdeadbeef", spec);
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.nodes.length).toBeLessThanOrEqual(3);
    expect(detectCycle(plan.nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn })))).toHaveLength(0);
  });

  test("rejects cycle and duplicate IDs", () => {
    const plan: any = {
      schemaVersion: 1,
      campaignId: "cmp_v1_deadbeefdeadbeefdeadbeef",
      estimatedTokens: 10,
      nodes: [
        { id: "a", dependsOn: ["b"], estimatedTokens: 1, taskSpec: { merge: { policy: "never" }, deploy: { policy: "never" }, git: { publication: "none" }, providerRouting: { provider: "local" }, authority: { allowProviderCalls: false, allowNetwork: false } } },
        { id: "a", dependsOn: ["a"], estimatedTokens: 1, taskSpec: { merge: { policy: "never" }, deploy: { policy: "never" }, git: { publication: "none" }, providerRouting: { provider: "local" }, authority: { allowProviderCalls: false, allowNetwork: false } } }
      ]
    };
    expect(() => validateCampaignPlan(plan, { maxTasks: 5, maxTokens: 100 }, authority, { requireOpenRouter: false })).toThrow(/duplicate/i);
  });

  test("rejects authority expansion, dangerous phases, and budget overflow", () => {
    const plan: any = {
      schemaVersion: 1,
      campaignId: "cmp_v1_deadbeefdeadbeefdeadbeef",
      estimatedTokens: 1000,
      estimatedCostUsd: 20,
      nodes: [
        { id: "a", dependsOn: [], estimatedTokens: 1000, estimatedCostUsd: 20, taskSpec: { authority: { allowProviderCalls: true, allowNetwork: true }, git: { publication: "draft-pr" }, merge: { policy: "always" }, deploy: { policy: "never" }, providerRouting: { provider: "local", fallbackPolicy: "same_provider" } } }
      ]
    };
    expect(() => validateCampaignPlan(plan, { maxTasks: 1, maxTokens: 100, maxCostUsd: 1 }, { ...authority, providerCalls: false, network: false }, { requireOpenRouter: false })).toThrow();
  });

  test("topological order is stable and openrouter local fallback is rejected", () => {
    const ordered = topoSortPlan([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["a"] }]);
    expect(ordered[0]).toBe("a");
    const plan: any = {
      schemaVersion: 1,
      campaignId: "cmp_v1_deadbeefdeadbeefdeadbeef",
      estimatedTokens: 10,
      nodes: [
        { id: "a", dependsOn: [], estimatedTokens: 1, taskSpec: { authority: { allowProviderCalls: true, allowNetwork: true }, merge: { policy: "never" }, deploy: { policy: "never" }, git: { publication: "none" }, providerRouting: { provider: "local", fallbackPolicy: "same_provider" } } }
      ]
    };
    expect(() => validateCampaignPlan(plan, { maxTasks: 2, maxTokens: 100 }, authority, { requireOpenRouter: true })).toThrow(/openrouter/i);
  });

  test("parseCampaignRequest rejects unknown fields", () => {
    expect(() =>
      parseCampaignRequest({
        goal: "x",
        target: { repository: process.cwd(), workingDirectory: "." },
        authority,
        providerRouting: { provider: "local" },
        limits: { maxTokens: 100, maxTasks: 1, maxConcurrency: 1 },
        children: []
      } as any)
    ).toThrow(/unknown field/i);
  });
});
