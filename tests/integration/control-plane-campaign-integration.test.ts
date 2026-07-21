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
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); plan.nodes = [plan.nodes[0]!]; plan.nodes[0]!.id = "implementation"; plan.nodes[0]!.dependsOn = []; plan.nodes[0]!.estimatedTokens = 2_000; plan.nodes[0]!.estimatedCostUsd = .1; (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src/new.ts"]; plan.estimatedTokens = 2_000; plan.estimatedCostUsd = .1; return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => {
        expect(input.taskSpec.providerRouting.tokenBudget.perPhase).toMatchObject({ planner: 0, repair: 0, reviewer: 0 });
        expect(input.taskSpec.providerRouting.tokenBudget.total).toBe(2_000);
        expect(input.taskSpec.providerRouting.tokenBudget.perPhase.implementer).toBe(2_000);
        expect(input.taskSpec.execution.maxProviderTokens).toBe(2_000);
        expect(input.taskSpec.execution.maxRepairIterations).toBe(0);
        const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts };
        tasks.set(task.id, task);
        return task;
      };
      (manager as any).getTask = async (id: string) => tasks.get(id);
      (manager as any).getResult = async () => ({ usage: { totalTokens: 200, costUsd: .01 }, implementation: { status: "completed" } });
      const campaign = await manager.createCampaign({ goal: "Add a small source file and verify it", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 } });
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
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); plan.nodes = [plan.nodes[0]!]; Object.assign(plan.nodes[0]!, { id: "implementation", dependsOn: [], estimatedTokens: 2_000, estimatedCostUsd: .1 }); Object.assign(plan, { estimatedTokens: 2_000, estimatedCostUsd: .1 }); return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Make a bounded change", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status).toBe("failed"); expect(final.children.implementation.error).toBe("IMPLEMENTATION_PATCH_MISSING"); expect(final.failures).toContainEqual(expect.objectContaining({ reason: "IMPLEMENTATION_PATCH_MISSING" })); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts a validation child without an implementation patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-campaign-validation-no-patch-")), repo = join(root, "repo"), state = join(root, "state"), artifacts = join(root, "child-artifacts");
    await mkdir(repo); await mkdir(state); await mkdir(artifacts);
    try {
      await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "README.md"), "base\n"); await exec("git", ["-C", repo, "add", "README.md"]); await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
      const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new ControlPlaneManager(new ControlPlaneStore(state)); await manager.initialize(); const tasks = new Map<string, any>();
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); plan.nodes = [plan.nodes[0]!]; Object.assign(plan.nodes[0]!, { id: "validation", dependsOn: [], estimatedTokens: 2_000, estimatedCostUsd: .1 }); (plan.nodes[0]!.taskSpec as any).execution.mode = "validation"; Object.assign(plan, { estimatedTokens: 2_000, estimatedCostUsd: .1 }); return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: artifacts }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Validate the bounded change", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify(final.failures)).toBe("completed"); manager.close();
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
      (manager as any).planCampaign = async (record: any) => { const plan = planCampaignFromGoal(record.id, record.spec); plan.nodes = [plan.nodes[0]!]; Object.assign(plan.nodes[0]!, { id: "implementation", dependsOn: [], estimatedTokens: 2_000, estimatedCostUsd: .1 }); (plan.nodes[0]!.taskSpec as any).discovery.explicitFiles = ["src.txt"]; Object.assign(plan, { estimatedTokens: 2_000, estimatedCostUsd: .1 }); return { plan, evidence: { mode: "semantic-openrouter", model: "test", attempts: 1, repaired: false, usage: { tokens: 100, costUsd: .001 }, validationCodes: [] } }; };
      (manager as any).createTask = async (input: any) => { calls += 1; const task = { id: input.taskSpec.taskId, status: "completed", error: null, artifactRoot: calls === 1 ? bad : good }; tasks.set(task.id, task); return task; }; (manager as any).getTask = async (id: string) => tasks.get(id); (manager as any).getResult = async () => ({ usage: { totalTokens: 100, costUsd: .01 } });
      const campaign = await manager.createCampaign({ goal: "Repair an integration conflict and run checks", target: { repository: repo, workingDirectory: ".", expectedSha: baseSha }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, providerRouting: { provider: "openrouter", model: "qwen/qwen3-coder-next", fallbackPolicy: "none" }, limits: { maxTokens: 10_000, maxCostUsd: 1, maxTasks: 2, maxConcurrency: 1 } });
      const deadline = Date.now() + 5_000; let final: any = campaign; while (Date.now() < deadline && !["completed", "failed", "on_hold"].includes(final.status)) { await new Promise((resolve) => setTimeout(resolve, 25)); final = await manager.getCampaign(campaign.id); }
      expect(final.status, JSON.stringify(final.failures)).toBe("completed"); expect(calls).toBe(2); expect(final.integration).toMatchObject({ repairAttempts: 1, status: "ready", lastError: null }); expect(final.children.implementation.integrationRepairAttempts).toBe(1); expect(final.usage.tasks).toBe(2); expect(await readFile(join(final.integration.worktreeRoot, "src.txt"), "utf8")).toBe("repaired\n"); expect(await readFile(join(repo, "src.txt"), "utf8")).toBe("base\n"); manager.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
