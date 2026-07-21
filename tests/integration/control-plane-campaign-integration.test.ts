import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ControlPlaneManager } from "../../src/control-plane/manager.js";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import { planCampaignFromGoal } from "../../src/run/task-run-planner.js";

const exec = promisify(execFile);

function addRequiredValidationSink(plan: ReturnType<typeof planCampaignFromGoal>, implementationId = "implementation"): void {
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
  (validation.taskSpec as any).validation = { mode: "explicit", commands: ["node --version", "git diff --check __CAMPAIGN_BASE__...HEAD"], requirements: [{ command: "node --version", acceptance: "required" }, { command: "git diff --check __CAMPAIGN_BASE__...HEAD", acceptance: "required" }], profile: { id: "test-final", defaultAcceptance: "required", defaultEvidenceRole: "test", additionalCapabilities: [] } };
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
      await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(artifacts, "implementation.patch"), ["diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+export const integrated = true;", ""].join("\n"));
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize();
      const tasks = new Map<string, any>();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.writeScopes = ["src"]; plan.nodes[0]!.estimatedTokens = 2_000; (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src/new.ts"]; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => {
        if (input.taskSpec.execution.mode === "implementation") {
          expect(input.taskSpec.providerRouting.tokenBudget.perPhase).toMatchObject({ planner: 0, repair: 0, reviewer: 0 });
          expect(input.taskSpec.providerRouting.tokenBudget.total).toBe(2_000);
          expect(input.taskSpec.providerRouting.tokenBudget.perPhase.implementer).toBe(2_000);
          expect(input.taskSpec.execution.maxProviderTokens).toBe(2_000);
          expect(input.taskSpec.execution.maxRepairIterations).toBe(0);
          expect(input.taskSpec.discovery.writeScopes).toEqual(["src"]);
        }
        const artifactRoot = input.taskSpec.execution.mode === "validation" ? join(root, "validation-artifacts") : artifacts;
        await mkdir(artifactRoot, { recursive: true });
        const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot };
        tasks.set(task.id, task);
        return task;
      };
      (manager as any).getTask = async (id: string) => tasks.get(id);
      (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 200, costUsd: .01 }, implementation: { status: "completed" } });
      const campaign = await manager.createCampaign({ goal: "Add a small source file and verify it", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign;
      while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify({ failures: final.failures, integration: final.integration }, null, 2)).toBe("completed"); expect(final.integration).toMatchObject({ status: "ready", appliedNodes: ["implementation"], baseSha }); expect(final.integration.headSha).not.toBe(baseSha); expect(final.checkpoints).toContain(final.integration.headSha);
      expect(await readFile(join(final.integration.worktreeRoot, "src/new.ts"), "utf8")).toContain("integrated");
      await expect(readFile(join(repo, "src/new.ts"), "utf8")).rejects.toThrow(); expect((await exec("git", ["-C", repo, "rev-parse", "main"])).stdout.trim()).toBe(baseSha);
      manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when an implementation child completes without its patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-no-patch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.estimatedTokens = 2_000; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Make a bounded change", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status).toBe("failed"); expect(final.children.implementation.error).toBe("IMPLEMENTATION_PATCH_MISSING"); expect(final.failures).toContainEqual(expect.objectContaining({ reason: "IMPLEMENTATION_PATCH_MISSING" })); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a validation-only custom plan for an implementation campaign", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-validation-no-patch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
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
      await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "src.txt"), "base\n"); await exec("git", ["-C", repo, "add", "src.txt"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]); const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(bad, "implementation.patch"), ["diff --git a/src.txt b/src.txt", "--- a/src.txt", "+++ b/src.txt", "@@ -1 +1 @@", "-wrong-base", "+bad", ""].join("\n"));
      await writeFile(join(good, "implementation.patch"), ["diff --git a/src.txt b/src.txt", "--- a/src.txt", "+++ b/src.txt", "@@ -1 +1 @@", "-base", "+repaired", ""].join("\n"));
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>(); let calls = 0;
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); addRequiredValidationSink(plan); plan.nodes[0]!.estimatedTokens = 2_000; plan.nodes[0]!.writeScopes = ["src.txt"]; (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src.txt"]; plan.estimatedTokens = 3_000; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const implementation = input.taskSpec.execution.mode === "implementation"; if (implementation) calls += 1; const artifactRoot = implementation ? (calls === 1 ? bad : good) : join(root, "validation-artifacts"); await mkdir(artifactRoot, { recursive: true }); const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ status: "workflow_completed", usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Repair an integration conflict and run checks", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 }, validationContract: { source: "explicit", requiredCommands: ["node --version"] } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify(final.failures)).toBe("completed"); expect(calls).toBe(2); expect(final.integration).toMatchObject({ repairAttempts: 1, status: "ready", lastError: null }); expect(final.children.implementation.integrationRepairAttempts).toBe(1); expect(final.usage.tasks).toBe(3); expect(await readFile(join(final.integration.worktreeRoot, "src.txt"), "utf8")).toBe("repaired\n"); expect(await readFile(join(repo, "src.txt"), "utf8")).toBe("base\n"); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
