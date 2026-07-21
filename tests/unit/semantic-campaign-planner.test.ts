import { describe, expect, it, vi } from "vitest";
import type { CampaignSpec } from "../../src/control-plane/contracts.js";
import type { OpenRouterExecutionResult } from "../../src/providers/openrouter-execution-provider.js";
import { planSemanticCampaign } from "../../src/run/semantic-campaign-planner.js";

const authority = { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false };
const spec = (provider: "openrouter" | "local" = "openrouter"): CampaignSpec => ({ goal: "Add arbitrary feature", target: { repository: ".", workingDirectory: ".", expectedSha: "abcdef1234567" }, authority, providerRouting: { provider, model: "qwen/qwen3-coder-next", fallbackPolicy: provider === "openrouter" ? "none" : "same_provider" }, limits: { maxTokens: 20_000, maxCostUsd: 1, maxTasks: 4, maxConcurrency: 2 } });
const response = (content: string, tokens = 100, costUsd = .001): OpenRouterExecutionResult => ({ content, usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 60, reasoningTokens: 0, totalTokens: tokens, costUsd }, requestId: "request", finishReason: "stop", attempts: 1 });
const valid = { nodes: [{ id: "inspect", goal: "Inspect feature", acceptanceCriteria: ["Evidence recorded"], dependsOn: [], explicitFiles: ["src/a.ts"], writeScopes: [], estimatedTokens: 4_000, estimatedCostUsd: .05 }, { id: "implement", goal: "Implement feature", acceptanceCriteria: ["Feature is implemented"], dependsOn: ["inspect"], explicitFiles: ["src/a.ts"], writeScopes: ["src/a.ts"], estimatedTokens: 6_000, estimatedCostUsd: .1 }, { id: "validate", goal: "Validate integrated feature", acceptanceCriteria: ["Focused tests pass"], dependsOn: ["implement"], explicitFiles: ["src/a.ts"], writeScopes: [], estimatedTokens: 2_000, estimatedCostUsd: .02 }] };

describe("semantic campaign planner", () => {
  it("turns a semantic draft into trusted bounded task specs", async () => {
    const chat = vi.fn(async () => response(JSON.stringify(valid)));
    const result = await planSemanticCampaign("cmp_v1_123456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: { files: ["src/a.ts"] } });
    expect(result.plan.nodes).toHaveLength(3);
    expect(result.plan.nodes[1]!.taskSpec).toMatchObject({ target: { expectedSha: "abcdef1234567" }, providerRouting: { provider: "openrouter", fallbackPolicy: "none" }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, discovery: { explicitFiles: ["src/a.ts"] } });
    expect(result.plan.nodes[1]!.taskSpec).toMatchObject({ task: { goal: "Implement feature", text: expect.stringContaining("Allowed write scopes: src/a.ts") } });
    expect(result.plan.nodes[1]!.taskSpec).toMatchObject({ validation: { mode: "explicit", commands: ["git diff --check"], requirements: [{ acceptance: "advisory" }], profile: { id: "campaign-intermediate", defaultAcceptance: "advisory" } } });
    expect(result.plan.nodes[2]!.taskSpec).toMatchObject({ execution: { mode: "validation" }, authority: { allowProviderCalls: false, allowNetwork: false }, runtime: { preference: "docker" }, validation: { mode: "explicit", commands: ["git diff --check"], requirements: [{ command: "git diff --check", acceptance: "required", capabilities: ["filesystem", "git-read-only-evidence", "git-metadata", "working-tree-index"] }], profile: { id: "campaign-final", defaultAcceptance: "required" } } });
    expect(result.plan.nodes[0]!.taskSpec).toMatchObject({ execution: { mode: "inspection" }, authority: { allowProviderCalls: false, allowNetwork: false } });
    expect(JSON.stringify(result.evidence)).not.toMatch(/src\/a|Evidence recorded|request/);
    expect(result.evidence).toMatchObject({ mode: "semantic-openrouter", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 } });
  });

  it("repairs one invalid draft and aggregates provider usage", async () => {
    const chat = vi.fn().mockResolvedValueOnce(response("not json", 10, .01)).mockResolvedValueOnce(response(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, 20, .02));
    const result = await planSemanticCampaign("cmp_v1_223456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.evidence).toMatchObject({ attempts: 2, repaired: true, validationCodes: ["INVALID_JSON"], usage: { tokens: 30, costUsd: .03 } });
    expect(JSON.stringify(chat.mock.calls[1]![0])).toContain("integer 1000 or greater");
  });

  it("fails closed after the second invalid draft", async () => {
    const chat = vi.fn(async () => response("not json"));
    await expect(planSemanticCampaign("cmp_v1_323456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} })).rejects.toThrow(/INVALID_JSON/);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("repairs concurrent overlapping scopes but permits dependent overlap", async () => {
    const overlap = { nodes: [{ ...valid.nodes[0], id: "a", dependsOn: [], writeScopes: ["src/a.ts"] }, { ...valid.nodes[1], id: "b", dependsOn: [] }] };
    const chat = vi.fn().mockResolvedValueOnce(response(JSON.stringify(overlap))).mockResolvedValueOnce(response(JSON.stringify(valid)));
    const result = await planSemanticCampaign("cmp_v1_423456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} });
    expect(result.evidence.validationCodes).toContain("OVERLAPPING_SCOPE");
    expect(result.plan.nodes[1]!.dependsOn).toEqual(["inspect"]);
  });

  it("repairs a final validation sink that requests write scopes", async () => {
    const invalid = structuredClone(valid);
    invalid.nodes[2]!.writeScopes = ["src/a.ts"];
    const chat = vi.fn().mockResolvedValueOnce(response(JSON.stringify(invalid))).mockResolvedValueOnce(response(JSON.stringify(valid)));
    const result = await planSemanticCampaign("cmp_v1_433456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.evidence.validationCodes).toContain("FINAL_VALIDATION_WRITE_SCOPES");
    expect(result.plan.nodes[2]!.writeScopes).toEqual([]);
  });

  it("repairs an independent implementation sink outside final validation", async () => {
    const invalid = structuredClone(valid);
    invalid.nodes.push({ id: "independent-implement", goal: "Implement unrelated feature", acceptanceCriteria: ["Feature is implemented"], dependsOn: [], explicitFiles: ["src/b.ts"], writeScopes: ["src/b.ts"], estimatedTokens: 2_000, estimatedCostUsd: .02 });
    const chat = vi.fn().mockResolvedValueOnce(response(JSON.stringify(invalid))).mockResolvedValueOnce(response(JSON.stringify(valid)));
    const result = await planSemanticCampaign("cmp_v1_443456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.evidence.validationCodes).toContain("NON_VALIDATION_FINAL_SINK");
    expect(result.plan.nodes.map((node) => node.id)).not.toContain("independent-implement");
  });

  it("repairs an implementation campaign with validation-only nodes", async () => {
    const invalid = structuredClone(valid);
    invalid.nodes[1]!.writeScopes = [];
    const chat = vi.fn().mockResolvedValueOnce(response(JSON.stringify(invalid))).mockResolvedValueOnce(response(JSON.stringify(valid)));
    const result = await planSemanticCampaign("cmp_v1_453456789012345678901234", spec(), { chatCompletion: chat, repositoryManifest: {} });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.evidence.validationCodes).toContain("MISSING_IMPLEMENTATION_NODE");
    expect(result.plan.nodes[1]!.writeScopes).toEqual(["src/a.ts"]);
  });

  it("keeps local campaigns deterministic without a provider call", async () => {
    const chat = vi.fn();
    const result = await planSemanticCampaign("cmp_v1_523456789012345678901234", spec("local"), { chatCompletion: chat });
    expect(chat).not.toHaveBeenCalled();
    expect(result.evidence).toMatchObject({ mode: "deterministic-local", attempts: 0, usage: { tokens: 0, costUsd: 0 } });
  });

  it("normalizes advisory child estimates while preserving the validated DAG", async () => {
    const oversized = structuredClone(valid); oversized.nodes.forEach((node) => { node.estimatedTokens = 15_000; node.estimatedCostUsd = 1; });
    const result = await planSemanticCampaign("cmp_v1_623456789012345678901234", spec(), { chatCompletion: async () => response(JSON.stringify(oversized)), repositoryManifest: {} });
    expect(result.plan.estimatedTokens).toBe(16_000); expect(result.plan.estimatedCostUsd).toBeCloseTo(.8);
    expect(result.evidence.validationCodes).toEqual(["TOKEN_ESTIMATES_NORMALIZED", "COST_ESTIMATES_NORMALIZED"]);
  });
});
