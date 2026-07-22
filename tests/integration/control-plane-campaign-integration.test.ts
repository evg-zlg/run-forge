import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import { selectOpenRouterExecutor } from "../../src/implementation/openrouter-executor.js";
import { normalizeTaskSpecV2 } from "../../src/product/task-spec-v2.js";
import { planCampaignFromGoal } from "../../src/run/task-run-planner.js";

const exec = promisify(execFile);
let previousPricing: string | undefined, previousExecutorCommand: string | undefined, previousOpenRouterKey: string | undefined;
beforeEach(() => { previousPricing = process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON; previousExecutorCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; previousOpenRouterKey = process.env.OPENROUTER_API_KEY; process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = JSON.stringify({ "qwen/qwen3-coder-next": { inputUsdPerToken: .00000001, outputUsdPerToken: .000001 } }); });
afterEach(() => { vi.unstubAllGlobals(); if (previousPricing === undefined) delete process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON; else process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON = previousPricing; if (previousExecutorCommand === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; else process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = previousExecutorCommand; if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousOpenRouterKey; });

function delegatedReviewFailure(): Record<string, unknown> {
  const reason = "Semantic reviewer invocation was unavailable: openrouter_max_calls_exceeded";
  const semanticReview = { kind: "semantic", status: "unavailable", performed: false, selectedReviewer: { provider: "openrouter", model: "qwen/qwen3-coder-next" }, reviewer: { provider: null, model: null, invocationId: null }, confidence: "unknown", limitations: [reason], findings: [], evidence: [], delegation: { party: "external_session", reason, exactAction: "Perform an independent semantic review in the delegated session and attach structured findings to this handoff." } };
  return { status: "completed", actualExecutorMode: "implementation", workflow: { status: "failed", implementationCompleted: true, validationCompleted: true, validationAggregate: "completed_with_validation_gaps", budgetExceeded: false, publicationBlocked: true, ownerDecisionRequired: false, handoff: { semanticReview } }, implementation: { status: "implemented_and_validated" }, validationAggregate: "completed_with_validation_gaps", review: { semantic: structuredClone(semanticReview) }, ownerGate: { required: false, status: "not_required" }, publication: { status: "on_hold", performed: false }, usage: { totalTokens: 200, costUsd: .01 } };
}

function addRequiredValidationSink(plan: ReturnType<typeof planCampaignFromGoal>, implementationId = "implementation", requiredCommands = ["node --version"]): void {
  const implementation = plan.nodes[0]!;
  const validation = structuredClone(implementation);
  implementation.id = implementationId;
  implementation.dependsOn = [];
  implementation.estimatedCostUsd = .1;
  (implementation.taskSpec as any).providerRouting.costBudgetUsd = .1;
  validation.id = "validation";
  validation.dependsOn = [implementationId];
  (validation.taskSpec as any).taskId = `${String((implementation.taskSpec as any).taskId)}_validation`;
  validation.writeScopes = [];
  validation.estimatedTokens = 1_000;
  validation.estimatedCostUsd = .1;
  (validation.taskSpec as any).execution.mode = "validation";
  (validation.taskSpec as any).authority = { ...(validation.taskSpec as any).authority, profile: "read-only", allowProviderCalls: false, allowNetwork: false };
  (validation.taskSpec as any).discovery = { ...(validation.taskSpec as any).discovery, writeScopes: [] };
  const commands = [...requiredCommands, "git diff --check __CAMPAIGN_BASE__...HEAD"];
  (validation.taskSpec as any).validation = { mode: "explicit", commands, requirements: commands.map((command) => ({ command, acceptance: "required" })), profile: { id: "test-final", defaultAcceptance: "required", defaultEvidenceRole: "test", additionalCapabilities: [] } };
  (validation.taskSpec as any).providerRouting.costBudgetUsd = .1;
  plan.nodes = [implementation, validation];
  plan.estimatedTokens = (implementation.estimatedTokens ?? 0) + 1_000;
  plan.estimatedCostUsd = .2;
}

describe("control plane campaign branch integration", () => {
  it("applies a child patch to the isolated campaign branch and preserves source main", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-branch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(artifacts, "implementation.patch"), ["diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+export const integrated = true;", ""].join("\n"));
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize();
      const tasks = new Map<string, any>(), taskModes = new Map<string, string>();
      const requiredCommands = ["corepack pnpm run typecheck", "corepack pnpm test", "corepack pnpm run build"];
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan, "implementation", requiredCommands); plan.nodes[0]!.writeScopes = ["src"]; plan.nodes[0]!.estimatedTokens = 2_000; const routing = (plan.nodes[0]!.taskSpec as any).providerRouting; routing.models.logCompression = "qwen/qwen3-coder-next"; routing.tokenBudget.perPhase.logCompression = 100; (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src/new.ts"]; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => {
        if (input.taskSpec.execution.mode === "implementation") {
          expect(input.taskSpec.providerRouting.tokenBudget.perPhase).toMatchObject({ planner: 0, repair: 200, reviewer: 200, logCompression: 100 });
          expect(input.taskSpec.providerRouting.tokenBudget.total).toBe(2_000);
          expect(input.taskSpec.providerRouting.tokenBudget.perPhase.implementer).toBe(1_500);
          expect(input.taskSpec.providerRouting.maxCalls).toBeGreaterThanOrEqual(4);
          expect(input.taskSpec.execution.maxProviderTokens).toBe(2_000);
          expect(input.taskSpec.execution.maxRepairIterations).toBe(1);
          expect(input.taskSpec.discovery.writeScopes).toEqual(["src"]);
          expect(input.taskSpec.validation.commands).toEqual(expect.arrayContaining(requiredCommands));
          for (const command of requiredCommands) expect(input.taskSpec.validation.requirements).toContainEqual(expect.objectContaining({ command, acceptance: "required" }));
        } else {
          expect(input.taskSpec.validation.commands).toEqual(expect.arrayContaining(requiredCommands));
        }
        const artifactRoot = input.taskSpec.execution.mode === "validation" ? join(root, "validation-artifacts") : artifacts;
        await mkdir(artifactRoot, { recursive: true });
        const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot };
        tasks.set(task.id, task);
        taskModes.set(task.id, input.taskSpec.execution.mode);
        return task;
      };
      (manager as any).getTask = async (id: string) => tasks.get(id);
      (manager as any).getResult = async (id: string) => taskModes.get(id) === "implementation"
        ? delegatedReviewFailure()
        : { status: "completed", workflow: { status: "workflow_completed" }, validationAggregate: "passed", usage: { totalTokens: 200, costUsd: .01 } };
      const campaign = await manager.createCampaign({ goal: "Add a small source file and verify it", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands } });
      const deadline = Date.now() + 5_000; let final: any = campaign;
      while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify({ failures: final.failures, integration: final.integration }, null, 2)).toBe("completed"); expect(final.children).toMatchObject({ implementation: { status: "completed" }, validation: { status: "completed" } }); expect([...taskModes.values()]).toEqual(expect.arrayContaining(["implementation", "validation"])); expect(final.integration).toMatchObject({ status: "ready", appliedNodes: ["implementation"], baseSha }); expect(final.integration.headSha).not.toBe(baseSha); expect(final.checkpoints).toContain(final.integration.headSha);
      expect(await readFile(join(final.integration.worktreeRoot, "src/new.ts"), "utf8")).toContain("integrated");
      await expect(readFile(join(repo, "src/new.ts"), "utf8")).rejects.toThrow(); expect((await exec("git", ["-C", repo, "rev-parse", "main"])).stdout.trim()).toBe(baseSha);
      manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a custom implementation child without a repair route valid and non-repairing", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-no-repair-route-")), repo = join(root, "repo"), state = join(root, "state"); await mkdir(repo); await mkdir(state); process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    let manager: ControlPlaneManager | null = null;
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]); const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>(); let resolveChecked!: () => void; const checked = new Promise<void>((resolve) => { resolveChecked = resolve; });
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); const implementation = plan.nodes[0]!, routing = (implementation.taskSpec as any).providerRouting; implementation.estimatedTokens = 2_000; delete routing.models?.repair; delete routing.modelPools?.repair; routing.tokenBudget.perPhase.repair = 0; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 1, costUsd: 0 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { if (input.taskSpec.execution.mode === "implementation") { expect(input.taskSpec.execution.maxRepairIterations).toBe(0); expect(input.taskSpec.providerRouting.tokenBudget.perPhase.repair).toBe(0); expect(input.taskSpec.providerRouting.models?.repair).toBeUndefined(); expect(input.taskSpec.providerRouting.modelPools?.repair).toBeUndefined(); const normalized = await normalizeTaskSpecV2(input.taskSpec); expect(selectOpenRouterExecutor(normalized)).toMatchObject({ selected: { id: "openrouter-coding-agent" } }); resolveChecked(); } const task = { id: input.taskSpec.taskId, status: "running", error: null, artifactRoot: join(root, "artifacts") }; tasks.set(task.id, task); return task; };
      (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => { throw new Error("result not expected"); };
      await manager.createCampaign({ goal: "Run a custom implementation without repair authority", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      await Promise.race([checked, new Promise((_, reject) => setTimeout(() => reject(new Error("implementation child was not dispatched")), 5_000))]);
    } finally { manager?.close(); await manager?.drain(); await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when an implementation child completes without its patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-no-patch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.estimatedTokens = 2_000; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async (id: string) => id.includes("validation") ? ({ status: "completed", workflow: { status: "workflow_completed" }, validationAggregate: "passed", usage: { totalTokens: 100, costUsd: .01 } }) : ({ status: "completed", workflow: { status: "awaiting_external_session" }, implementation: { status: "implemented_and_validated" }, validationAggregate: "passed", usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Make a bounded change", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status).toBe("failed"); expect(final.children.implementation.error).toBe("IMPLEMENTATION_PATCH_MISSING"); expect(final.failures).toContainEqual(expect.objectContaining({ reason: "IMPLEMENTATION_PATCH_MISSING" })); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retries owner-gated completed implementation from its durable checkpoint without creating a fresh implementation task", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-checkpoint-retry-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]); const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(artifacts, "implementation.patch"), ["diff --git a/repaired.ts b/repaired.ts", "new file mode 100644", "--- /dev/null", "+++ b/repaired.ts", "@@ -0,0 +1 @@", "+export const repaired = true;", ""].join("\n"));
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>(), modes = new Map<string, string>(); let implementationCreates = 0, repairCalls = 0, implementationId = "";
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.writeScopes = ["repaired.ts"]; plan.nodes[0]!.estimatedTokens = 2_000; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 10, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const mode = input.taskSpec.execution.mode; if (mode === "implementation") { implementationCreates += 1; implementationId = input.taskSpec.taskId; } const task = { id: input.taskSpec.taskId, status: mode === "implementation" ? "awaiting_owner_decision" : "completed", error: mode === "implementation" ? "validation_failed" : null, artifactRoot: mode === "implementation" ? artifacts : join(root, "validation-artifacts") }; await mkdir(task.artifactRoot, { recursive: true }); tasks.set(task.id, task); modes.set(task.id, mode); return task; };
      (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async (id: string) => modes.get(id) === "validation" ? { status: "completed", workflow: { status: "workflow_completed" }, validationAggregate: "passed", usage: { totalTokens: 50, costUsd: .001 } } : tasks.get(id)?.status === "awaiting_owner_decision" ? { status: "awaiting_owner_decision", workflow: { implementationCompleted: true }, implementation: { status: "implemented" }, artifact: { checkpoints: [{ id: "implementation-0", digest: "a".repeat(64) }] }, usage: { totalTokens: 100, costUsd: .01 } } : delegatedReviewFailure();
      (manager as any).repairFromCheckpoint = async (id: string, request: any) => { repairCalls += 1; expect(id).toBe(implementationId); expect(request).toMatchObject({ taskId: implementationId, checkpointId: "implementation-0", checkpointDigest: "a".repeat(64), choice: "retry_from_checkpoint", additionalProviderTokens: 0 }); tasks.get(id).status = "completed"; tasks.get(id).error = null; return { status: "repair_generation_started" }; };
      const campaign = await manager.createCampaign({ goal: "Repair validation without repeating implementation", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify(final.failures)).toBe("completed"); expect(implementationCreates).toBe(1); expect(repairCalls).toBe(1); expect(final.children.implementation).toMatchObject({ taskId: implementationId, status: "completed", executionRetryAttempts: 1 }); expect(final.usage.tasks).toBe(3); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("starts provider checkpoint repair through the real manager and executor using the projected repair budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-real-checkpoint-")), repo = join(root, "repo"), state = join(root, "state"); await cp(join(process.cwd(), "tests/fixtures/implementation/simple-js"), repo, { recursive: true });
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${join(process.cwd(), "tests/fixtures/implementation/coding-agent-adapter.mjs")}`;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const implementationDiff = ["diff --git a/calculator.js b/calculator.js", "--- a/calculator.js", "+++ b/calculator.js", "@@ -1,3 +1,3 @@", " export function add(a, b) {", "-  return a - b;", "+  return a + b;", " }", ""].join("\n");
    const repairDiff = ["diff --git a/calculator.js b/calculator.js", "--- a/calculator.js", "+++ b/calculator.js", "@@ -1,3 +1,4 @@", "+// Revalidated from the durable implementation checkpoint.", " export function add(a, b) {", "   return a + b;", " }", ""].join("\n");
    let implementationCalls = 0;
    const providerFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const requiresDiff = system.includes("raw unified git diff");
      const content = requiresDiff && implementationCalls++ === 0
        ? implementationDiff
        : requiresDiff ? repairDiff : JSON.stringify({ semanticReview: { confidence: "high", limitations: [], findings: [] } });
      const totalTokens = requiresDiff && implementationCalls === 1 ? 145_000 : 100;
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: totalTokens - 20, completion_tokens: 20, total_tokens: totalTokens } }), { status: 200, headers: { "x-request-id": `campaign-provider-${providerFetch.mock.calls.length}` } });
    });
    vi.stubGlobal("fetch", providerFetch);
    let manager: ControlPlaneManager | null = null;
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await exec("git", ["-C", repo, "add", "."]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]); const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const logCompressionInvoker: any = async ({ rawDigest }: any) => ({ content: JSON.stringify({ schemaVersion: 1, kind: "log-digest", summary: "Compressed local campaign logs.", failureClass: "test.validation", diagnostics: ["Use local validation evidence."], sources: rawDigest.sources.map(({ redactions: _redactions, ...source }: any) => source) }), model: "test/log", requestId: "campaign-log", tokenUsage: 1, inputTokens: 1, outputTokens: 0, reasoningTokens: 0, costUsd: 0, attempts: 1 });
      manager = new ControlPlaneManager(new ControlPlaneStore(state), undefined, undefined, { logCompressionInvoker }); await manager.initialize();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan, "implementation", ["node test.js", "node typecheck.js"]); const implementation = plan.nodes[0]!, routing = (implementation.taskSpec as any).providerRouting; (implementation.taskSpec as any).task.text = "BUDGET_OVERRUN REPAIR_LOOP fix add without repeating completed implementation"; implementation.writeScopes = ["calculator.js"]; implementation.estimatedTokens = 150_000; routing.models.logCompression = "qwen/qwen3-coder-next"; routing.tokenBudget.perPhase = { planner: 0, implementer: 140_000, repair: 5_000, reviewer: 4_000, logCompression: 1_000 }; routing.tokenBudget.total = 150_000; plan.nodes[1]!.estimatedTokens = 10_000; (plan.nodes[1]!.taskSpec as any).runtime.externalNetwork = "denied"; plan.estimatedTokens = 160_000; delete plan.estimatedCostUsd; for (const node of plan.nodes) { delete node.estimatedCostUsd; delete (node.taskSpec as any).providerRouting.costBudgetUsd; } return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: [] } }; };
      const campaign = await manager.createCampaign({ goal: "Repair validation from the durable implementation checkpoint", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 200_000, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node test.js", "node typecheck.js"] } });
      const deadline = Date.now() + 20_000; let observed: any = campaign, task: any = null; while (Date.now() < deadline) { observed = await manager.getCampaign(campaign.id); const taskId = observed.children.implementation?.taskId; if (taskId) { task = await manager.getTask(taskId).catch(() => null); if (task?.execution.attempt === 2 && task.status === "completed") break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
      const child = observed.children.implementation, acceptedSpec = await manager.store.readSpec(child.taskId); expect(child).toMatchObject({ executionRetryAttempts: 1, checkpointRepair: { state: "started", additionalProviderTokens: 0 } }); expect(task).toMatchObject({ status: "completed", execution: { attempt: 2 }, checkpointRepair: { choice: "retry_from_checkpoint", additionalProviderTokens: 0, repairExecutionId: expect.any(String) } }); expect((acceptedSpec as any).providerRouting.tokenBudget.perPhase.repair).toBe(5_000); expect((acceptedSpec as any).providerRouting.maxCalls).toBeGreaterThanOrEqual(4); expect(providerFetch).toHaveBeenCalled();
    } finally { manager?.close(); await manager?.drain(); await exec("chmod", ["-R", "u+w", root]).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects a validation-only custom plan for an implementation campaign", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-validation-no-patch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes = [plan.nodes[1]!]; plan.nodes[0]!.dependsOn = []; plan.estimatedTokens = 1_000; plan.estimatedCostUsd = .1; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 100, costUsd: .01 } });
      await expect(manager.createCampaign({ goal: "Validate the bounded change", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } })).rejects.toThrow(/at least one implementation node/i); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("re-runs a conflicting node once on the current integration head", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-repair-")), repo = join(root, "repo"), state = join(root, "state"), bad = join(root, "bad"), good = join(root, "good");
    await mkdir(repo); await mkdir(state); await mkdir(bad); await mkdir(good);
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "src.txt"), "base\n"); await exec("git", ["-C", repo, "add", "src.txt"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]); const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(bad, "implementation.patch"), ["diff --git a/src.txt b/src.txt", "--- a/src.txt", "+++ b/src.txt", "@@ -1 +1 @@", "-wrong-base", "+bad", ""].join("\n"));
      await writeFile(join(good, "implementation.patch"), ["diff --git a/src.txt b/src.txt", "--- a/src.txt", "+++ b/src.txt", "@@ -1 +1 @@", "-base", "+repaired", ""].join("\n"));
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>(); let calls = 0;
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.estimatedTokens = 2_000; plan.nodes[0]!.writeScopes = ["src.txt"]; (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src.txt"]; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const implementation = input.taskSpec.execution.mode === "implementation"; if (implementation) calls += 1; const artifactRoot = implementation ? (calls === 1 ? bad : good) : join(root, "validation-artifacts"); await mkdir(artifactRoot, { recursive: true }); const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async (id: string) => id.includes("validation") ? ({ status: "completed", workflow: { status: "workflow_completed" }, validationAggregate: "passed", usage: { totalTokens: 100, costUsd: .01 } }) : ({ status: "completed", workflow: { status: "awaiting_external_session" }, implementation: { status: "implemented_and_validated" }, validationAggregate: "passed", usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Repair an integration conflict and run checks", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify(final.failures)).toBe("completed"); expect(calls).toBe(2); expect(final.integration).toMatchObject({ repairAttempts: 1, status: "ready", lastError: null }); expect(final.children.implementation.integrationRepairAttempts).toBe(1); expect(final.usage.tasks).toBe(3); expect(await readFile(join(final.integration.worktreeRoot, "src.txt"), "utf8")).toBe("repaired\n"); expect(await readFile(join(repo, "src.txt"), "utf8")).toBe("base\n"); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
