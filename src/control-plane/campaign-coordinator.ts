import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectCycle, validateCampaignPlan } from "../run/task-run-planner.js";
import { SemanticCampaignPlannerError, type CampaignPlannerEvidence, type SemanticCampaignPlannerResult } from "../run/semantic-campaign-planner.js";
import { boundPublicResult } from "./manager-results.js";
import { ControlPlaneError, type CampaignPlan, type CampaignRecord, type CampaignSpec, type ControlTaskRecord } from "./contracts.js";
import { CampaignIntegration, CampaignIntegrationError } from "./campaign-integration.js";
import { accountCampaignChildUsage, aggregateCampaignUsage as aggregateUsageFromValue, campaignChildCompletion, childReservationTokens, deterministicPlannerEvidence, failedPlannerEvidence, finiteNumber, object, reconcileCampaignResult, releaseCampaignReservation, reserveCampaignChild, reservedUsage, taskIdFromSpec, usageFromEvidence } from "./campaign-coordinator-state.js";

type Deps = {
  root: string;
  planCampaign: (record: CampaignRecord) => Promise<CampaignPlan | SemanticCampaignPlannerResult>;
  createTask: (input: { projectId?: string; taskSpec: Record<string, unknown>; authority: CampaignSpec["authority"]; publicationRequested: "none" | "draft-pr" }) => Promise<ControlTaskRecord>;
  getTask: (id: string) => Promise<ControlTaskRecord>;
  getResult: (id: string) => Promise<Record<string, unknown>>;
  integration?: CampaignIntegration;
};

export class CampaignCoordinator {
  private readonly activeCampaignLoops = new Map<string, Promise<void>>();
  private readonly integration: CampaignIntegration;
  constructor(private readonly deps: Deps) { this.integration = deps.integration ?? new CampaignIntegration(); }
  async initialize(): Promise<void> { for (const campaign of await this.readCampaigns()) if (["planning", "queued", "running"].includes(campaign.status)) this.ensureCampaignLoop(campaign.id); }
  close(): void { this.activeCampaignLoops.clear(); }
  async createCampaign(spec: CampaignSpec): Promise<CampaignRecord> {
    if (!spec.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a campaign.");
    if (spec.authority.implementation && !spec.authority.providerCalls) throw new ControlPlaneError(403, "authority_denied", "Campaign authority expansion rejected: implementation requires providerCalls authority.");
    if (spec.authority.implementation && spec.providerRouting.provider === "local") throw new ControlPlaneError(422, "invalid_campaign", "Local implementation campaigns are disabled; use an isolated OpenRouter integration campaign.");
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter" && spec.target.projectId) throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter implementation campaigns require a repository target, not projectId dual binding.");
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter" && (!spec.authority.localBranch || !spec.authority.localCommit)) throw new ControlPlaneError(403, "authority_denied", "OpenRouter implementation campaigns require localBranch and localCommit authority for isolated reconciliation.");
    if (spec.providerRouting.provider === "openrouter" && spec.providerRouting.fallbackPolicy && spec.providerRouting.fallbackPolicy !== "none") throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter campaigns must set fallbackPolicy='none'.");
    if (spec.providerRouting.provider === "local" && spec.providerRouting.fallbackPolicy === "same_provider") throw new ControlPlaneError(422, "invalid_campaign", "Local campaigns do not support same-provider fallback semantics.");
    const now = new Date().toISOString();
    const id = `cmp_v1_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const record: CampaignRecord = { schemaVersion: 1, id, status: "planning", spec, plan: null, plannerEvidence: null, integration: null, children: {}, usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 0, costUsd: 0 }, checkpoints: [], failures: [], result: null, createdAt: now, updatedAt: now };
    // Generic Git integrity is not a complete project validation contract.
    if (spec.authority.implementation && !spec.validationContract?.requiredCommands.length) {
      record.status = "on_hold";
      record.failures.push({ at: now, reason: "campaign_validation_contract_unknown" });
      record.result = reconcileCampaignResult(record);
      await this.saveCampaign(record);
      return record;
    }
    let planning: CampaignPlan | SemanticCampaignPlannerResult;
    try { planning = await this.deps.planCampaign(record); }
    catch (error) {
      record.status = "failed";
      record.plannerEvidence = error instanceof SemanticCampaignPlannerError ? error.evidence : failedPlannerEvidence();
      record.usage.tokens = usageFromEvidence(record.plannerEvidence).tokens;
      record.usage.costUsd = usageFromEvidence(record.plannerEvidence).costUsd;
      record.failures.push({ at: now, reason: "semantic_campaign_planning_failed" });
      record.result = reconcileCampaignResult(record);
      await this.saveCampaign(record);
      return record;
    }
    const semantic = "plan" in planning ? planning : { plan: planning, evidence: deterministicPlannerEvidence() };
    const plan = semantic.plan;
    const plannerUsage = usageFromEvidence(semantic.evidence);
    record.usage.tokens += plannerUsage.tokens;
    record.usage.costUsd += plannerUsage.costUsd;
    record.plannerEvidence = { ...semantic.evidence, createdAt: now, nodeCount: plan.nodes.length };
    const plannedBudgetExceeded = record.usage.tokens + plan.estimatedTokens > spec.limits.maxTokens || (spec.limits.maxCostUsd !== undefined && record.usage.costUsd + (plan.estimatedCostUsd ?? 0) > spec.limits.maxCostUsd);
    if (plannedBudgetExceeded) {
      record.plan = plan;
      record.status = "failed";
      record.failures.push({ at: now, reason: "campaign_budget_exceeded" });
      record.result = reconcileCampaignResult(record);
      await this.saveCampaign(record);
      return record;
    }
    validateCampaignPlan(plan, { maxTasks: spec.limits.maxTasks, maxTokens: spec.limits.maxTokens, maxCostUsd: spec.limits.maxCostUsd }, spec.authority, { requireOpenRouter: spec.providerRouting.provider === "openrouter" });
    const cycle = detectCycle(plan.nodes.map((item) => ({ id: item.id, dependsOn: item.dependsOn })));
    if (cycle.length) throw new ControlPlaneError(422, "campaign_cycle_detected", `Campaign plan contains a cycle: ${cycle.join(" -> ")}`);
    record.plan = plan;
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter") {
      try {
        const worktree = await this.integration.ensureCampaignWorktree({ sourceRepository: spec.target.repository ?? ".", stateRoot: this.deps.root, campaignId: id, baseSha: spec.target.expectedSha ?? "HEAD" });
        record.integration = { status: "ready", worktreeRoot: worktree.worktreeRoot, branch: worktree.branch, baseSha: worktree.headSha, headSha: worktree.headSha, appliedNodes: [], repairAttempts: 0, lastError: null };
      } catch {
        record.status = "failed"; record.failures.push({ at: now, reason: "campaign_integration_worktree_failed" }); record.result = reconcileCampaignResult(record); await this.saveCampaign(record); return record;
      }
    }
    record.children = Object.fromEntries(plan.nodes.map((node) => [node.id, { nodeId: node.id, dependsOn: node.dependsOn, taskId: null, status: "pending", startedAt: null, finishedAt: null, error: null, accounted: false, reservedTokens: 0, reservedCostUsd: 0, integrationRepairAttempts: 0, executionRetryAttempts: 0 }]));
    record.status = "queued";
    record.updatedAt = new Date().toISOString();
    await this.saveCampaign(record);
    this.ensureCampaignLoop(record.id);
    return record;
  }
  async listCampaigns(): Promise<Array<Pick<CampaignRecord, "id" | "status" | "createdAt" | "updatedAt" | "usage">>> { return (await this.readCampaigns()).map((item) => ({ id: item.id, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, usage: item.usage })); }
  async getCampaign(id: string): Promise<CampaignRecord> { const campaign = await this.readCampaign(id); if (!campaign) throw new ControlPlaneError(404, "campaign_not_found", `Campaign not found: ${id}`); return campaign; }
  async getCampaignResult(id: string): Promise<Record<string, unknown>> {
    const campaign = await this.getCampaign(id);
    if (!["completed", "failed", "on_hold"].includes(campaign.status) || !campaign.result) throw new ControlPlaneError(404, "campaign_result_not_ready", `Campaign result is not ready: ${id}`);
    return campaign.result;
  }
  private ensureCampaignLoop(id: string): void {
    if (this.activeCampaignLoops.has(id)) return;
    const loop = this.runCampaign(id).catch((error) => this.handleCampaignLoopFailure(id, error)).finally(() => this.activeCampaignLoops.delete(id));
    this.activeCampaignLoops.set(id, loop);
  }
  private async handleCampaignLoopFailure(id: string, error: unknown): Promise<void> {
    const campaign = await this.readCampaign(id);
    if (!campaign || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
    const reason = error instanceof ControlPlaneError ? `campaign_task_rejected:${error.code}` : "campaign_internal_error";
    campaign.failures.push({ at: new Date().toISOString(), reason });
    await this.finishCampaign(campaign, "failed");
  }
  private async runCampaign(id: string): Promise<void> {
    while (true) {
      const campaign = await this.readCampaign(id);
      if (!campaign || !campaign.plan || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
      campaign.status = "running";
      let progressed = false;
      for (const child of Object.values(campaign.children)) {
        if (child.status === "dispatching") {
          const node = campaign.plan.nodes.find((item) => item.id === child.nodeId);
          if (!node) return this.failReservedChild(campaign, child, "CAMPAIGN_NODE_MISSING");
          await this.dispatchReservedChild(campaign, child, node, this.taskSpecForNode(campaign, node));
          progressed = true;
          continue;
        }
        if (!child.taskId || !["queued", "running"].includes(child.status)) continue;
        const task = await this.deps.getTask(child.taskId).catch(() => null);
        if (!task) continue;
        if (task.status === "completed") {
          progressed = true;
          const result = await this.deps.getResult(child.taskId).catch(() => ({}));
          const completion = campaignChildCompletion(result);
          if (!completion.completed) {
            const at = new Date().toISOString();
            child.status = "blocked"; child.finishedAt = at; child.error = completion.reason;
            child.evidence = boundPublicResult(result).result;
            campaign.failures.push({ at, nodeId: child.nodeId, taskId: child.taskId, reason: completion.reason });
            campaign.status = "on_hold";
            return this.finishCampaign(campaign, "on_hold");
          }
          if (!child.accounted) {
            accountCampaignChildUsage(campaign, child, result);
            const integrationStatus = await this.integrateCompletedChild(campaign, child, task);
            if (integrationStatus === "repair_started") continue;
            if (integrationStatus === "failed") { campaign.status = "failed"; continue; }
          }
          child.status = "completed";
          child.finishedAt = new Date().toISOString();
        } else if (["failed", "interrupted", "awaiting_owner_decision"].includes(task.status)) {
          progressed = true;
          if (!child.accounted) { const result = await this.deps.getResult(child.taskId).catch(() => ({})); accountCampaignChildUsage(campaign, child, result); }
          if (await this.retryFailedChild(campaign, child, task.error ?? "CHILD_EXECUTION_FAILED")) continue;
          child.status = "failed"; child.finishedAt = new Date().toISOString(); child.error = task.error ?? "child_failed"; campaign.status = "failed"; campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, taskId: child.taskId, reason: child.error });
        } else child.status = "running";
      }
      if (campaign.status === "failed") return this.finishCampaign(campaign, "failed");
      if (campaign.usage.tokens > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd > campaign.spec.limits.maxCostUsd)) {
        campaign.status = "failed";
        campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" });
        return this.finishCampaign(campaign, "failed");
      }
      const activeChildren = Object.values(campaign.children).filter((item) => ["dispatching", "queued", "running"].includes(item.status)).length;
      const slots = Math.max(0, campaign.spec.limits.maxConcurrency - activeChildren);
      if (slots > 0) {
        const ready = campaign.plan.nodes.filter((node) => {
          const child = campaign.children[node.id];
          if (!child || child.status !== "pending") return false;
          return node.dependsOn.every((dep) => campaign.children[dep]?.status === "completed");
        }).slice(0, slots);
        for (const node of ready) {
          if (campaign.usage.tokens + reservedUsage(campaign).tokens + (node.estimatedTokens ?? 0) > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd + reservedUsage(campaign).costUsd + (node.estimatedCostUsd ?? 0) > campaign.spec.limits.maxCostUsd)) {
            campaign.status = "failed";
            campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" });
            return this.finishCampaign(campaign, "failed");
          }
          const child = campaign.children[node.id]!;
          reserveCampaignChild(campaign, child, node, taskIdFromSpec(this.taskSpecForNode(campaign, node)));
          // Persist before dispatch so restart reconciliation cannot spend this budget twice.
          await this.saveCampaign(campaign);
          await this.dispatchReservedChild(campaign, child, node, this.taskSpecForNode(campaign, node));
          progressed = true;
        }
      }
      if (Object.values(campaign.children).every((child) => child.status === "completed")) {
        campaign.status = "completed";
        return this.finishCampaign(campaign, "completed");
      }
      campaign.updatedAt = new Date().toISOString();
      await this.saveCampaign(campaign);
      if (!progressed && Object.values(campaign.children).every((child) => child.status === "pending")) {
        campaign.status = "on_hold";
        campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_no_schedulable_children" });
        return this.finishCampaign(campaign, "on_hold");
      }
      await this.waitForChildSignal(campaign);
    }
  }
  private async waitForChildSignal(campaign: CampaignRecord): Promise<void> {
    const activeTaskIds = Object.values(campaign.children).filter((child) => child.taskId && ["queued", "running"].includes(child.status)).map((child) => child.taskId as string);
    if (!activeTaskIds.length) return;
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      for (const taskId of activeTaskIds) {
        const task = await this.deps.getTask(taskId).catch(() => null);
        if (task && ["completed", "failed", "interrupted", "awaiting_owner_decision"].includes(task.status)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  /** Adopt a durable TaskSpec taskId before creating a replacement after restart. */
  private async dispatchReservedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], node: CampaignPlan["nodes"][number], taskSpec: Record<string, unknown>): Promise<void> {
    const expectedId = child.taskId ?? taskIdFromSpec(taskSpec);
    if (!expectedId) throw new ControlPlaneError(422, "invalid_campaign", `Campaign node '${node.id}' has no deterministic task id.`);
    const bind = async (task: ControlTaskRecord): Promise<void> => {
      child.taskId = task.id;
      child.status = task.status === "queued" ? "queued" : "running";
      child.startedAt ??= new Date().toISOString();
      campaign.updatedAt = new Date().toISOString();
      // Persist immediately after the external createTask side effect.
      await this.saveCampaign(campaign);
    };
    const existing = await this.deps.getTask(expectedId).catch(() => null);
    if (existing) return bind(existing);
    let created: ControlTaskRecord;
    try {
      created = await this.deps.createTask({ ...this.taskProjectBinding(campaign), taskSpec, authority: campaign.spec.authority, publicationRequested: "none" });
    } catch (error) {
      // Reconcile a deterministic id created concurrently after our first read.
      const raced = await this.deps.getTask(expectedId).catch(() => null);
      if (raced) return bind(raced);
      releaseCampaignReservation(campaign, child);
      child.taskId = null;
      child.status = "pending";
      child.startedAt = null;
      child.error = "campaign_child_dispatch_failed";
      await this.saveCampaign(campaign);
      throw error;
    }
    await bind(created);
  }
  private async failReservedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], reason: string): Promise<void> {
    releaseCampaignReservation(campaign, child);
    child.status = "failed";
    child.finishedAt = new Date().toISOString();
    child.error = reason;
    campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, ...(child.taskId ? { taskId: child.taskId } : {}), reason });
    await this.finishCampaign(campaign, "failed");
  }
  private async finishCampaign(campaign: CampaignRecord, status: CampaignRecord["status"]): Promise<void> {
    campaign.status = status;
    campaign.result = reconcileCampaignResult(campaign);
    campaign.updatedAt = new Date().toISOString();
    await this.saveCampaign(campaign);
  }
  private taskSpecForNode(campaign: CampaignRecord, node: CampaignPlan["nodes"][number], repair?: { nodeId: string; attempt: number; code: string; kind: "ir" | "er" }): Record<string, unknown> {
    const source = node.taskSpec;
    const taskSpec = structuredClone(source), target = object(taskSpec.target), task = object(taskSpec.task);
    // Keep the planner write boundary executable and distinct from read context.
    const discovery = object(taskSpec.discovery);
    taskSpec.discovery = { ...discovery, writeScopes: [...(node.writeScopes ?? [])] };
    const integration = campaign.integration;
    if (integration) {
      taskSpec.target = { ...target, repository: integration.worktreeRoot, workingDirectory: campaign.spec.target.workingDirectory ?? ".", expectedSha: integration.headSha };
      const routing = object(taskSpec.providerRouting), tokenBudget = object(routing.tokenBudget), execution = object(taskSpec.execution), implementation = execution.mode === "implementation";
      const configuredTotal = finiteNumber(tokenBudget.total) ?? finiteNumber(execution.maxProviderTokens) ?? 1_000;
      // A node estimate is a hard reservation bounded by the live campaign remainder.
      const nodeReservation = finiteNumber(node.estimatedTokens) ?? configuredTotal;
      // Protect peers without subtracting this child's own authorized reservation.
      const campaignRemaining = Math.max(0, campaign.spec.limits.maxTokens - campaign.usage.tokens - reservedUsage(campaign).tokens + childReservationTokens(campaign, node.id));
      const total = Math.min(configuredTotal, nodeReservation, campaignRemaining);
      taskSpec.execution = implementation ? { ...execution, maxRepairIterations: 0, maxProviderTokens: total } : execution;
      taskSpec.providerRouting = { ...routing, maxCalls: implementation ? 1 : routing.maxCalls, tokenBudget: { ...tokenBudget, total, perPhase: implementation ? { planner: 0, implementer: total, repair: 0, reviewer: 0 } : object(tokenBudget.perPhase) } };
      // Bind final validation to the integrated head and immutable campaign base.
      const validation = object(taskSpec.validation);
      if (typeof validation.mode === "string" && Array.isArray(validation.commands)) {
        const replaceBase = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("__CAMPAIGN_BASE__", integration.baseSha) : value;
        validation.commands = validation.commands.map(replaceBase);
        if (Array.isArray(validation.requirements)) validation.requirements = validation.requirements.map((requirement) => {
          const item = object(requirement);
          return Object.keys(item).length ? { ...item, command: replaceBase(item.command) } : requirement;
        });
        taskSpec.validation = validation;
      }
    }
    if (repair) { taskSpec.taskId = `${campaign.id.slice(0, 48)}_${repair.nodeId.slice(0, 18)}_${repair.kind}${repair.attempt}`; taskSpec.task = { ...task, text: `Re-implement this bounded node against the current integrated campaign head after ${repair.code}. ${String(task.text ?? "")}` }; }
    return taskSpec;
  }
  private taskProjectBinding(campaign: CampaignRecord): { projectId?: string } { return !campaign.integration && campaign.spec.target.projectId ? { projectId: campaign.spec.target.projectId } : {}; }
  private async integrateCompletedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], task: ControlTaskRecord): Promise<"complete" | "repair_started" | "failed"> {
    if (!campaign.plan) return "complete";
    const node = campaign.plan.nodes.find((item) => item.id === child.nodeId);
    if (!node) return this.integrationFailure(campaign, child, "CAMPAIGN_NODE_MISSING");
    if (!campaign.integration) return "complete";
    const patchPath = join(task.artifactRoot, "implementation.patch");
    const execution = object(node.taskSpec.execution);
    if (!await lstat(patchPath).catch(() => null)) {
      // Only implementation children must produce an integration patch.
      return execution.mode === "implementation" ? this.integrationFailure(campaign, child, "IMPLEMENTATION_PATCH_MISSING") : "complete";
    }
    const discovery = object(node.taskSpec.discovery), allowedScopes = node.writeScopes ?? (Array.isArray(discovery.explicitFiles) ? discovery.explicitFiles.filter((item): item is string => typeof item === "string") : []);
    try {
      const integrated = await this.integration.integrateChildPatch({ stateRoot: this.deps.root, worktreeRoot: campaign.integration.worktreeRoot, patchRoot: task.artifactRoot, patchPath, allowedScopes, nodeId: node.id, maxPatchBytes: finiteNumber(object(node.taskSpec.execution).maxPatchBytes) ?? 500_000 });
      campaign.integration.headSha = integrated.headSha;
      campaign.integration.lastError = null;
      if (!campaign.integration.appliedNodes.includes(node.id)) campaign.integration.appliedNodes.push(node.id);
      if (integrated.commit && !campaign.checkpoints.includes(integrated.commit)) campaign.checkpoints.push(integrated.commit);
      return "complete";
    } catch (error) {
      const code = error instanceof CampaignIntegrationError ? error.code : "CAMPAIGN_INTEGRATION_FAILED";
      campaign.integration.lastError = code;
      const attempt = (child.integrationRepairAttempts ?? 0) + 1;
      const withinBudget = attempt <= 1 && campaign.usage.tokens + reservedUsage(campaign).tokens + (node.estimatedTokens ?? 0) <= campaign.spec.limits.maxTokens && (campaign.spec.limits.maxCostUsd === undefined || campaign.usage.costUsd + reservedUsage(campaign).costUsd + (node.estimatedCostUsd ?? 0) <= campaign.spec.limits.maxCostUsd);
      if (!withinBudget) return this.integrationFailure(campaign, child, code);
      const repairSpec = this.taskSpecForNode(campaign, node, { nodeId: node.id, attempt, code, kind: "ir" });
      child.status = "pending"; child.taskId = null; child.accounted = false; child.integrationRepairAttempts = attempt; child.finishedAt = null; child.error = null;
      try {
        reserveCampaignChild(campaign, child, node, taskIdFromSpec(repairSpec));
        await this.saveCampaign(campaign);
        await this.dispatchReservedChild(campaign, child, node, repairSpec);
      } catch {
        return this.integrationFailure(campaign, child, "INTEGRATION_REPAIR_START_FAILED");
      }
      campaign.integration.repairAttempts += 1;
      return "repair_started";
    }
  }
  private async retryFailedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], code: string): Promise<boolean> {
    if (!campaign.plan) return false;
    const node = campaign.plan.nodes.find((item) => item.id === child.nodeId), attempt = (child.executionRetryAttempts ?? 0) + 1;
    if (!node || attempt > 1 || campaign.usage.tokens + reservedUsage(campaign).tokens + (node.estimatedTokens ?? 0) > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd + reservedUsage(campaign).costUsd + (node.estimatedCostUsd ?? 0) > campaign.spec.limits.maxCostUsd)) return false;
    const retrySpec = this.taskSpecForNode(campaign, node, { nodeId: node.id, attempt, code, kind: "er" });
    child.status = "pending"; child.taskId = null; child.accounted = false; child.executionRetryAttempts = attempt; child.finishedAt = null; child.error = null;
    try {
      reserveCampaignChild(campaign, child, node, taskIdFromSpec(retrySpec));
      await this.saveCampaign(campaign);
      await this.dispatchReservedChild(campaign, child, node, retrySpec);
      return true;
    } catch { return false; }
  }
  private integrationFailure(campaign: CampaignRecord, child: CampaignRecord["children"][string], code: string): "failed" { const at = new Date().toISOString(); releaseCampaignReservation(campaign, child); child.status = "failed"; child.finishedAt = at; child.error = code; if (campaign.integration) { campaign.integration.status = "failed"; campaign.integration.lastError = code; } campaign.failures.push({ at, nodeId: child.nodeId, ...(child.taskId ? { taskId: child.taskId } : {}), reason: code }); return "failed"; }
  private campaignsDir(): string { return join(this.deps.root, "campaigns"); }
  private campaignPath(id: string): string { return join(this.campaignsDir(), `${id}.json`); }
  private async saveCampaign(campaign: CampaignRecord): Promise<void> { await mkdir(this.campaignsDir(), { recursive: true }); const destination = this.campaignPath(campaign.id); const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(campaign, null, 2) + "\n", "utf8"); await rename(temp, destination); }
  private async readCampaign(id: string): Promise<CampaignRecord | null> { try { return JSON.parse(await readFile(this.campaignPath(id), "utf8")) as CampaignRecord; } catch { return null; } }
  private async readCampaigns(): Promise<CampaignRecord[]> {
    await mkdir(this.campaignsDir(), { recursive: true });
    const names = (await readdir(this.campaignsDir())).filter((item) => item.endsWith(".json"));
    const entries = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(this.campaignsDir(), name), "utf8")) as CampaignRecord));
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
