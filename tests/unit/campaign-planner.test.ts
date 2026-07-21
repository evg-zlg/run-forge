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

  test("rejects implementation plans whose terminal sinks are not complete read-only validation", () => {
    const task = (mode: string, commands: string[], profile = "read-only") => ({ execution: { mode }, authority: { profile, allowProviderCalls: false, allowNetwork: false }, discovery: { writeScopes: [] }, validation: { mode: "explicit", commands, requirements: commands.map((command) => ({ command, acceptance: "required" })) }, providerRouting: { provider: "openrouter", costBudgetUsd: .1, fallbackPolicy: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, git: { publication: "none" } });
    const base: any = { schemaVersion: 1, campaignId: "cmp_v1_deadbeefdeadbeefdeadbeef", estimatedTokens: 2_000, estimatedCostUsd: .2, nodes: [
      { id: "implement", dependsOn: [], writeScopes: ["src/a.ts"], estimatedTokens: 1_000, estimatedCostUsd: .1, taskSpec: task("implementation", ["git diff --check"]) },
      { id: "sink", dependsOn: ["implement"], writeScopes: [], estimatedTokens: 1_000, estimatedCostUsd: .1, taskSpec: task("inspection", ["corepack pnpm test", "git diff --check __CAMPAIGN_BASE__...HEAD"]) },
    ] };
    const options = { requireOpenRouter: true, implementation: true, requiredValidationCommands: ["corepack pnpm test"] };
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/terminal node.*validation-only/i);
    base.nodes[1].taskSpec.execution.mode = "validation";
    base.nodes[1].taskSpec.validation.commands = ["git diff --check __CAMPAIGN_BASE__...HEAD"];
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/omit required command/i);
    base.nodes[1].taskSpec.validation.commands = ["corepack pnpm test", "git diff --check"];
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/meaningful campaign Git diff range/i);
    base.nodes[1].taskSpec.validation.commands = ["corepack pnpm test", "git diff --check __CAMPAIGN_BASE__...HEAD"];
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).not.toThrow();
    base.nodes[1].taskSpec.validation.requirements[0].acceptance = "advisory";
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/command must have required acceptance/i);
    base.nodes[1].taskSpec.validation.requirements[0].acceptance = "required";
    base.nodes[1].taskSpec.validation.requirements.push({ command: "corepack pnpm test", acceptance: "advisory" });
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/command must have required acceptance/i);
    base.nodes[1].taskSpec.validation.requirements.pop();
    base.nodes[1].taskSpec.validation.requirements[1].acceptance = "advisory";
    expect(() => validateCampaignPlan(base, { maxTasks: 2, maxTokens: 3_000, maxCostUsd: 1 }, authority, options)).toThrow(/Git integrity requirement.*required acceptance/i);
  });

  test("requires one global terminal validation sink after every implementation node", () => {
    const task = (mode: "implementation" | "validation", commands: string[] = []) => ({ execution: { mode }, authority: { profile: mode === "validation" ? "read-only" : "bounded-implementation", allowProviderCalls: false, allowNetwork: false }, discovery: { writeScopes: mode === "implementation" ? ["src"] : [] }, validation: { mode: "explicit", commands, requirements: commands.map((command) => ({ command, acceptance: "required" })) }, providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } });
    const commands = ["node --version", "git diff --check __CAMPAIGN_BASE__...HEAD"];
    const plan: any = { schemaVersion: 1, campaignId: "cmp_v1_globalvalidationdeadbeef", estimatedTokens: 3_000, nodes: [
      { id: "a", dependsOn: [], writeScopes: ["src/a.ts"], estimatedTokens: 1_000, taskSpec: task("implementation") },
      { id: "b", dependsOn: [], writeScopes: ["src/b.ts"], estimatedTokens: 1_000, taskSpec: task("implementation") },
      { id: "validate", dependsOn: ["a"], writeScopes: [], estimatedTokens: 1_000, taskSpec: task("validation", commands) },
    ] };
    const options = { requireOpenRouter: true, implementation: true, requiredValidationCommands: ["node --version"] };
    expect(() => validateCampaignPlan(plan, { maxTasks: 4, maxTokens: 4_000 }, authority, options)).toThrow(/exactly one global terminal validation sink/i);
    plan.nodes[2].dependsOn = ["a", "b"];
    expect(() => validateCampaignPlan(plan, { maxTasks: 4, maxTokens: 4_000 }, authority, options)).not.toThrow();
    plan.nodes.push({ id: "second-sink", dependsOn: ["a", "b"], writeScopes: [], estimatedTokens: 1_000, taskSpec: task("validation", commands) }); plan.estimatedTokens = 4_000;
    expect(() => validateCampaignPlan(plan, { maxTasks: 4, maxTokens: 4_000 }, authority, options)).toThrow(/exactly one global terminal validation sink/i);
    plan.nodes = [{ ...plan.nodes.find((node: any) => node.id === "validate"), dependsOn: [] }]; plan.estimatedTokens = 1_000;
    expect(() => validateCampaignPlan(plan, { maxTasks: 4, maxTokens: 4_000 }, authority, options)).toThrow(/at least one implementation node/i);
  });

  test("requires cost estimates and child cost caps for every OpenRouter node under a hard cost limit", () => {
    const plan: any = { schemaVersion: 1, campaignId: "cmp_v1_deadbeefdeadbeefdeadbeef", estimatedTokens: 1_000, estimatedCostUsd: 0, nodes: [{ id: "inspect", dependsOn: [], estimatedTokens: 1_000, taskSpec: { providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, authority: {}, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } } }] };
    expect(() => validateCampaignPlan(plan, { maxTasks: 1, maxTokens: 2_000, maxCostUsd: 1 }, authority, { requireOpenRouter: true })).toThrow(/finite cost estimate/i);
    plan.nodes[0].estimatedCostUsd = .1; plan.estimatedCostUsd = .1;
    expect(() => validateCampaignPlan(plan, { maxTasks: 1, maxTokens: 2_000, maxCostUsd: 1 }, authority, { requireOpenRouter: true })).toThrow(/child cost cap/i);
  });
});
