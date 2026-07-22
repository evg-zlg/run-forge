import { randomUUID } from "node:crypto"; import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { detectCycle, validateCampaignPlan } from "../run/task-run-planner.js";
import { SemanticCampaignPlannerError, type CampaignPlannerEvidence, type SemanticCampaignPlannerResult } from "../run/semantic-campaign-planner.js";
import { boundPublicResult } from "./manager-results.js";
import { ControlPlaneError, type CampaignPlan, type CampaignRecord, type CampaignSpec, type ControlTaskRecord } from "./contracts.js";
import { CampaignIntegration, CampaignIntegrationError } from "./campaign-integration.js";
import { accountCampaignChildUsage, aggregateCampaignUsage as aggregateUsageFromValue, campaignChildCompletion, childReservationTokens, deterministicPlannerEvidence, failedPlannerEvidence, finiteNumber, object, reconcileCampaignResult, releaseCampaignReservation, reserveCampaignChild, reservedUsage, taskIdFromSpec, usageFromEvidence } from "./campaign-coordinator-state.js";
import { CampaignCoordinatorLease } from "./campaign-coordinator-lease.js";
import { CampaignRecordStore } from "./campaign-record-store.js"; import { projectCampaignValidation, projectPhaseBudgets, routingHasPhase, withoutRoutingPhase } from "./campaign-child-projection.js";

type Deps = {
  root: string; planCampaign: (record: CampaignRecord) => Promise<CampaignPlan | SemanticCampaignPlannerResult>;
  createTask: (input: { projectId?: string; taskSpec: Record<string, unknown>; authority: CampaignSpec["authority"]; publicationRequested: "none" | "draft-pr" }) => Promise<ControlTaskRecord>;
  getTask: (id: string) => Promise<ControlTaskRecord>;
  getResult: (id: string) => Promise<Record<string, unknown>>; repairTaskFromCheckpoint?: (id: string, request: { taskId: string; decisionId: string; checkpointId: string; checkpointDigest: string; choice: "retry_from_checkpoint"; additionalProviderTokens: number; repairIntent: string }) => Promise<Record<string, unknown>>; preflightCampaign?: (id: string, spec: CampaignSpec) => void;
  integration?: CampaignIntegration;
};
export class CampaignCoordinator {
  private readonly activeCampaignLoops = new Map<string, Promise<void>>();
  private readonly activeCampaignCreates = new Set<Promise<CampaignRecord>>();
  private readonly integration: CampaignIntegration; private readonly lease: CampaignCoordinatorLease; private readonly records: CampaignRecordStore;
  private generation = 0; private closing: Promise<void> | null = null; private stopped = false;
  constructor(private readonly deps: Deps) { this.integration = deps.integration ?? new CampaignIntegration(); this.lease = new CampaignCoordinatorLease(deps.root); this.records = new CampaignRecordStore(deps.root); }
  async initialize(): Promise<void> { this.activate(); try { for (const campaign of await this.readCampaigns()) if (["planning", "queued", "running"].includes(campaign.status)) this.ensureCampaignLoop(campaign.id); } catch (error) { this.close(); throw error; } }
  close(): void { if (this.stopped) return; this.stopped = true; this.generation += 1; const work = [...this.activeCampaignCreates, ...this.activeCampaignLoops.values()]; const closing = Promise.allSettled(work).then(() => { this.activeCampaignLoops.clear(); this.lease.release(); }); this.closing = closing.finally(() => { this.closing = null; }); }
  async drain(): Promise<void> { this.close(); await this.closing; }
  createCampaign(spec: CampaignSpec): Promise<CampaignRecord> { this.activate(); const generation = this.generation; let operation: Promise<CampaignRecord>; operation = this.createCampaignActive(spec, generation).finally(() => this.activeCampaignCreates.delete(operation)); this.activeCampaignCreates.add(operation); return operation; }
  private async createCampaignActive(spec: CampaignSpec, generation: number): Promise<CampaignRecord> {
    if (!spec.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a campaign.");
    if (spec.providerRouting.provider === "openrouter" && (!spec.authority.providerCalls || !spec.authority.network)) throw new ControlPlaneError(403, "authority_denied", "OpenRouter campaigns require providerCalls and network authority before semantic planning.");
    if (spec.authority.implementation && !spec.authority.providerCalls) throw new ControlPlaneError(403, "authority_denied", "Campaign authority expansion rejected: implementation requires providerCalls authority.");
    if (spec.authority.implementation && spec.providerRouting.provider === "local") throw new ControlPlaneError(422, "invalid_campaign", "Local implementation campaigns are disabled; use an isolated OpenRouter integration campaign.");
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter" && !spec.target.repository) throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter implementation campaigns require an explicit target.repository.");
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter" && spec.target.projectId) throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter implementation campaigns require a repository target, not projectId dual binding.");
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter" && (!spec.authority.localBranch || !spec.authority.localCommit)) throw new ControlPlaneError(403, "authority_denied", "OpenRouter implementation campaigns require localBranch and localCommit authority for isolated reconciliation.");
    if (spec.providerRouting.provider === "openrouter" && spec.providerRouting.fallbackPolicy && spec.providerRouting.fallbackPolicy !== "none") throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter campaigns must set fallbackPolicy='none'.");
    if (spec.providerRouting.provider === "local" && spec.providerRouting.fallbackPolicy === "same_provider") throw new ControlPlaneError(422, "invalid_campaign", "Local campaigns do not support same-provider fallback semantics.");
    const now = new Date().toISOString();
    const id = `cmp_v1_${randomUUID().replace(/-/g, "").slice(0, 24)}`; this.deps.preflightCampaign?.(id, spec);
    const record: CampaignRecord = { schemaVersion: 1, id, status: "planning", spec, plan: null, plannerEvidence: null, integration: null, children: {}, usage: { tokens: 0, costUsd: 0, tasks: 0 }, reserved: { tokens: 0, costUsd: 0 }, checkpoints: [], failures: [], result: null, createdAt: now, updatedAt: now };
    if (spec.authority.implementation && !spec.validationContract?.requiredCommands.length) {
      record.status = "on_hold";
      record.failures.push({ at: now, reason: "campaign_validation_contract_unknown" });
      record.result = reconcileCampaignResult(record);
      await this.saveCampaign(record, generation);
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
      await this.saveCampaign(record, generation);
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
      await this.saveCampaign(record, generation);
      return record;
    }
    validateCampaignPlan(plan, { maxTasks: spec.limits.maxTasks, maxTokens: spec.limits.maxTokens, maxCostUsd: spec.limits.maxCostUsd }, spec.authority, { requireOpenRouter: spec.providerRouting.provider === "openrouter", implementation: spec.authority.implementation, requiredValidationCommands: spec.validationContract?.requiredCommands });
    const cycle = detectCycle(plan.nodes.map((item) => ({ id: item.id, dependsOn: item.dependsOn })));
    if (cycle.length) throw new ControlPlaneError(422, "campaign_cycle_detected", `Campaign plan contains a cycle: ${cycle.join(" -> ")}`);
    record.plan = plan;
    if (spec.authority.implementation && spec.providerRouting.provider === "openrouter") {
      try {
        this.assertCurrent(generation);
        const worktree = await this.integration.ensureCampaignWorktree({ sourceRepository: spec.target.repository ?? ".", stateRoot: this.deps.root, campaignId: id, baseSha: spec.target.expectedSha ?? "HEAD" });
        this.assertCurrent(generation);
        record.integration = { status: "ready", worktreeRoot: worktree.worktreeRoot, branch: worktree.branch, baseSha: worktree.headSha, headSha: worktree.headSha, appliedNodes: [], repairAttempts: 0, lastError: null };
      } catch {
        record.status = "failed"; record.failures.push({ at: now, reason: "campaign_integration_worktree_failed" }); record.result = reconcileCampaignResult(record); await this.saveCampaign(record, generation); return record;
      }
    }
    record.children = Object.fromEntries(plan.nodes.map((node) => [node.id, { nodeId: node.id, dependsOn: node.dependsOn, taskId: null, status: "pending", startedAt: null, finishedAt: null, error: null, accounted: false, reservedTokens: 0, reservedCostUsd: 0, integrationRepairAttempts: 0, executionRetryAttempts: 0 }]));
    record.status = "queued";
    record.updatedAt = new Date().toISOString();
    await this.saveCampaign(record, generation);
    this.assertCurrent(generation);
    this.ensureCampaignLoop(record.id);
    return record;
  }
  async listCampaigns(): Promise<Array<Pick<CampaignRecord, "id" | "status" | "createdAt" | "updatedAt" | "usage">>> { return (await this.readCampaigns()).map((item) => ({ id: item.id, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, usage: item.usage })); }
  async getCampaign(id: string): Promise<CampaignRecord> { const campaign = await this.readCampaign(id); if (!campaign) throw new ControlPlaneError(404, "campaign_not_found", `Campaign not found: ${id}`); return campaign; }
  async getCampaignResult(id: string): Promise<Record<string, unknown>> { const campaign = await this.getCampaign(id); if (!["completed", "failed", "on_hold"].includes(campaign.status) || !campaign.result) throw new ControlPlaneError(404, "campaign_result_not_ready", `Campaign result is not ready: ${id}`); return campaign.result; }
  private activate(): void { if (this.stopped) throw new ControlPlaneError(409, "campaign_coordinator_closed", "Campaign coordinator shutdown has started and cannot be reactivated."); if (!this.lease.active) { this.lease.acquire(); this.generation += 1; } } private current(generation: number): boolean { return this.lease.active && this.generation === generation; }
  private assertCurrent(generation: number): void { if (!this.current(generation)) throw new ControlPlaneError(409, "campaign_generation_fenced", "A stale campaign coordinator generation cannot persist state."); }
  private ensureCampaignLoop(id: string): void {
    if (this.activeCampaignLoops.has(id)) return;
    const generation = this.generation;
    let loop: Promise<void>;
    loop = this.runCampaign(id, generation).catch((error) => this.current(generation) ? this.handleCampaignLoopFailure(id, error, generation) : undefined).finally(() => { if (this.activeCampaignLoops.get(id) === loop) this.activeCampaignLoops.delete(id); });
    this.activeCampaignLoops.set(id, loop);
  }
  private async handleCampaignLoopFailure(id: string, error: unknown, generation: number): Promise<void> {
    const campaign = await this.readCampaign(id);
    if (!campaign || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
    const reason = error instanceof ControlPlaneError ? `campaign_task_rejected:${error.code}` : "campaign_internal_error";
    campaign.failures.push({ at: new Date().toISOString(), reason });
    await this.finishCampaign(campaign, "failed", generation);
  }
  private async runCampaign(id: string, generation: number): Promise<void> {
    while (true) {
      if (!this.current(generation)) return;
      const campaign = await this.readCampaign(id);
      if (!campaign || !campaign.plan || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
      campaign.status = "running";
      let progressed = false;
      for (const child of Object.values(campaign.children)) {
        if (child.status === "dispatching") {
          if (!this.current(generation)) return; const node = campaign.plan.nodes.find((item) => item.id === child.nodeId);
          if (!node) return this.failReservedChild(campaign, child, "CAMPAIGN_NODE_MISSING", generation);
          if (child.checkpointRepair?.state === "pending") { if (await this.startPendingCheckpointRepair(campaign, child, generation)) { progressed = true; continue; } if (!this.current(generation)) return; releaseCampaignReservation(campaign, child); child.accounted = true; child.status = "blocked"; child.finishedAt = new Date().toISOString(); child.error = "campaign_checkpoint_repair_required"; return this.finishCampaign(campaign, "on_hold", generation); }
          await this.dispatchReservedChild(campaign, child, node, this.taskSpecForNode(campaign, node), generation);
          progressed = true;
          continue;
        }
        if (!child.taskId || !["queued", "running"].includes(child.status)) continue;
        const task = await this.deps.getTask(child.taskId).catch(() => null);
        if (!task) continue;
        if (task.status === "completed") {
          progressed = true;
          const result = await this.deps.getResult(child.taskId).catch(() => ({}));
          const node = campaign.plan.nodes.find((item) => item.id === child.nodeId);
          const completion = campaignChildCompletion(result, typeof object(node?.taskSpec.execution).mode === "string" ? object(node?.taskSpec.execution).mode : undefined);
          if (!completion.completed) {
            const at = new Date().toISOString();
            child.status = "blocked"; child.finishedAt = at; child.error = completion.reason;
            child.evidence = boundPublicResult(result).result;
            campaign.failures.push({ at, nodeId: child.nodeId, taskId: child.taskId, reason: completion.reason });
            campaign.status = "on_hold";
            return this.finishCampaign(campaign, "on_hold", generation);
          }
          if (!child.accounted) {
            accountCampaignChildUsage(campaign, child, result);
            if (!this.current(generation)) return; const integrationStatus = await this.integrateCompletedChild(campaign, child, task, generation);
            if (integrationStatus === "repair_started") continue;
            if (integrationStatus === "failed") { campaign.status = "failed"; continue; }
          }
          child.status = "completed";
          child.finishedAt = new Date().toISOString();
        } else if (["failed", "interrupted", "awaiting_owner_decision"].includes(task.status)) {
          progressed = true;
          const result = await this.deps.getResult(child.taskId).catch(() => ({})); if (!child.accounted) accountCampaignChildUsage(campaign, child, result);
          if (implementationCheckpoint(result)) { if (!this.current(generation)) return; if (await this.retryFromCheckpoint(campaign, child, task, result, generation)) continue; if (!this.current(generation)) return; if (child.checkpointRepair?.state === "pending") { releaseCampaignReservation(campaign, child); child.accounted = true; } child.status = "blocked"; child.finishedAt = new Date().toISOString(); child.error = "campaign_checkpoint_repair_required"; campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, taskId: child.taskId, reason: child.error }); return this.finishCampaign(campaign, "on_hold", generation); }
          if (!this.current(generation)) return; if (await this.retryFailedChild(campaign, child, task.error ?? "CHILD_EXECUTION_FAILED", generation)) continue;
          child.status = "failed"; child.finishedAt = new Date().toISOString(); child.error = task.error ?? "child_failed"; campaign.status = "failed"; campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, taskId: child.taskId, reason: child.error });
        } else child.status = "running";
      }
      if (campaign.status === "failed") return this.finishCampaign(campaign, "failed", generation);
      if (campaign.usage.tokens > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd > campaign.spec.limits.maxCostUsd)) {
        campaign.status = "failed";
        campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" });
        return this.finishCampaign(campaign, "failed", generation);
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
            return this.finishCampaign(campaign, "failed", generation);
          }
          const child = campaign.children[node.id]!;
          if (!this.current(generation)) return; reserveCampaignChild(campaign, child, node, taskIdFromSpec(this.taskSpecForNode(campaign, node)));
          await this.saveCampaign(campaign, generation);
          await this.dispatchReservedChild(campaign, child, node, this.taskSpecForNode(campaign, node), generation);
          progressed = true;
        }
      }
      if (Object.values(campaign.children).every((child) => child.status === "completed")) {
        campaign.status = "completed";
        return this.finishCampaign(campaign, "completed", generation);
      }
      campaign.updatedAt = new Date().toISOString();
      await this.saveCampaign(campaign, generation);
      if (!progressed && Object.values(campaign.children).every((child) => child.status === "pending")) {
        campaign.status = "on_hold";
        campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_no_schedulable_children" });
        return this.finishCampaign(campaign, "on_hold", generation);
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
  private async dispatchReservedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], node: CampaignPlan["nodes"][number], taskSpec: Record<string, unknown>, generation: number): Promise<void> {
    const expectedId = child.taskId ?? taskIdFromSpec(taskSpec);
    if (!expectedId) throw new ControlPlaneError(422, "invalid_campaign", `Campaign node '${node.id}' has no deterministic task id.`);
    const bind = async (task: ControlTaskRecord): Promise<void> => {
      child.taskId = task.id;
      child.status = task.status === "queued" ? "queued" : "running";
      child.startedAt ??= new Date().toISOString();
      campaign.updatedAt = new Date().toISOString();
      await this.saveCampaign(campaign, generation);
    };
    const existing = await this.deps.getTask(expectedId).catch(() => null);
    if (existing) return bind(existing);
    let created: ControlTaskRecord;
    try {
      this.assertCurrent(generation); created = await this.deps.createTask({ ...this.taskProjectBinding(campaign), taskSpec, authority: campaign.spec.authority, publicationRequested: "none" });
    } catch (error) {
      const raced = await this.deps.getTask(expectedId).catch(() => null);
      if (raced) return bind(raced);
      releaseCampaignReservation(campaign, child);
      child.taskId = null;
      child.status = "pending";
      child.startedAt = null;
      child.error = "campaign_child_dispatch_failed";
      await this.saveCampaign(campaign, generation);
      throw error;
    }
    await bind(created);
  }
  private async failReservedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], reason: string, generation: number): Promise<void> {
    releaseCampaignReservation(campaign, child);
    child.status = "failed";
    child.finishedAt = new Date().toISOString();
    child.error = reason;
    campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, ...(child.taskId ? { taskId: child.taskId } : {}), reason });
    await this.finishCampaign(campaign, "failed", generation);
  }
  private async finishCampaign(campaign: CampaignRecord, status: CampaignRecord["status"], generation: number): Promise<void> {
    campaign.status = status;
    campaign.result = reconcileCampaignResult(campaign);
    campaign.updatedAt = new Date().toISOString();
    await this.saveCampaign(campaign, generation);
  }
  private taskSpecForNode(campaign: CampaignRecord, node: CampaignPlan["nodes"][number], repair?: { nodeId: string; attempt: number; code: string; kind: "ir" | "er" }): Record<string, unknown> {
    const source = node.taskSpec;
    const taskSpec = structuredClone(source), target = object(taskSpec.target), task = object(taskSpec.task);
    const discovery = object(taskSpec.discovery);
    taskSpec.discovery = { ...discovery, writeScopes: [...(node.writeScopes ?? [])] }; projectCampaignValidation(taskSpec, campaign, node);
    const integration = campaign.integration;
    if (integration) {
      taskSpec.target = { ...target, repository: integration.worktreeRoot, workingDirectory: campaign.spec.target.workingDirectory ?? ".", expectedSha: integration.headSha };
      const routing = object(taskSpec.providerRouting), tokenBudget = object(routing.tokenBudget), execution = object(taskSpec.execution), implementation = execution.mode === "implementation";
      const configuredTotal = finiteNumber(tokenBudget.total) ?? finiteNumber(execution.maxProviderTokens) ?? 1_000;
      const nodeReservation = finiteNumber(node.estimatedTokens) ?? configuredTotal;
      const campaignRemaining = Math.max(0, campaign.spec.limits.maxTokens - campaign.usage.tokens - reservedUsage(campaign).tokens + childReservationTokens(campaign, node.id));
      const total = Math.floor(Math.max(0, Math.min(configuredTotal, nodeReservation, campaignRemaining)));
      if (total < 1_000) throw new ControlPlaneError(409, "campaign_budget_exhausted", `Campaign node '${node.id}' cannot receive the minimum executable 1000-token budget.`);
      const perPhase = object(tokenBudget.perPhase), hasLogCompressionRouting = routingHasPhase(routing, "logCompression"), hasReviewerRouting = routingHasPhase(routing, "reviewer"), hasRepairRouting = implementation && routingHasPhase(routing, "repair"), allocation = projectPhaseBudgets(perPhase, total, implementation, hasLogCompressionRouting, hasReviewerRouting, hasRepairRouting); let adjustedRouting = allocation.logCompression > 0 ? routing : withoutRoutingPhase(routing, "logCompression"); if (allocation.reviewer === 0) adjustedRouting = withoutRoutingPhase(adjustedRouting, "reviewer"); if (allocation.repair === 0) adjustedRouting = withoutRoutingPhase(adjustedRouting, "repair");
      const retryAttempts = Math.max(1, Math.floor(finiteNumber(object(routing.retry).maxAttempts) ?? 1)), requiredCalls = Object.values(allocation).filter((budget) => budget > 0).length * retryAttempts;
      taskSpec.execution = { ...execution, ...(implementation ? { maxRepairIterations: hasRepairRouting ? 1 : 0 } : {}), maxProviderTokens: total }; taskSpec.providerRouting = { ...adjustedRouting, maxCalls: Math.max(Math.floor(finiteNumber(routing.maxCalls) ?? 1), requiredCalls), tokenBudget: { ...tokenBudget, total, perPhase: allocation } };
      const validation = object(taskSpec.validation);
      if (typeof validation.mode === "string" && Array.isArray(validation.commands)) {
        const replaceBase = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("__CAMPAIGN_BASE__", integration.baseSha) : value;
        validation.commands = validation.commands.map(replaceBase);
        if (Array.isArray(validation.requirements)) validation.requirements = validation.requirements.map((requirement) => { const item = object(requirement); return Object.keys(item).length ? { ...item, command: replaceBase(item.command) } : requirement; });
        taskSpec.validation = validation;
      }
    }
    if (repair) { taskSpec.taskId = `${campaign.id.slice(0, 48)}_${repair.nodeId.slice(0, 18)}_${repair.kind}${repair.attempt}`; taskSpec.task = { ...task, text: `Re-implement this bounded node against the current integrated campaign head after ${repair.code}. ${String(task.text ?? "")}` }; }
    return taskSpec;
  }
  private taskProjectBinding(campaign: CampaignRecord): { projectId?: string } { return !campaign.integration && campaign.spec.target.projectId ? { projectId: campaign.spec.target.projectId } : {}; }
  private async integrateCompletedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], task: ControlTaskRecord, generation: number): Promise<"complete" | "repair_started" | "failed"> {
    if (!campaign.plan) return "complete";
    const node = campaign.plan.nodes.find((item) => item.id === child.nodeId);
    if (!node) return this.integrationFailure(campaign, child, "CAMPAIGN_NODE_MISSING");
    if (!campaign.integration) return "complete";
    const patchPath = join(task.artifactRoot, "implementation.patch");
    const execution = object(node.taskSpec.execution);
    if (!await lstat(patchPath).catch(() => null)) {
      return execution.mode === "implementation" ? this.integrationFailure(campaign, child, "IMPLEMENTATION_PATCH_MISSING") : "complete";
    }
    const discovery = object(node.taskSpec.discovery), allowedScopes = node.writeScopes ?? (Array.isArray(discovery.explicitFiles) ? discovery.explicitFiles.filter((item): item is string => typeof item === "string") : []);
    try {
      this.assertCurrent(generation); const integrated = await this.integration.integrateChildPatch({ stateRoot: this.deps.root, worktreeRoot: campaign.integration.worktreeRoot, patchRoot: task.artifactRoot, patchPath, allowedScopes, nodeId: node.id, maxPatchBytes: finiteNumber(object(node.taskSpec.execution).maxPatchBytes) ?? 500_000 }); this.assertCurrent(generation);
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
        await this.saveCampaign(campaign, generation);
        await this.dispatchReservedChild(campaign, child, node, repairSpec, generation);
      } catch {
        return this.integrationFailure(campaign, child, "INTEGRATION_REPAIR_START_FAILED");
      }
      campaign.integration.repairAttempts += 1;
      return "repair_started";
    }
  }
  private async retryFailedChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], code: string, generation: number): Promise<boolean> {
    if (!campaign.plan) return false;
    const node = campaign.plan.nodes.find((item) => item.id === child.nodeId), attempt = (child.executionRetryAttempts ?? 0) + 1;
    if (!node || attempt > 1 || campaign.usage.tokens + reservedUsage(campaign).tokens + (node.estimatedTokens ?? 0) > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd + reservedUsage(campaign).costUsd + (node.estimatedCostUsd ?? 0) > campaign.spec.limits.maxCostUsd)) return false;
    const retrySpec = this.taskSpecForNode(campaign, node, { nodeId: node.id, attempt, code, kind: "er" });
    child.status = "pending"; child.taskId = null; child.accounted = false; child.executionRetryAttempts = attempt; child.finishedAt = null; child.error = null;
    try {
      reserveCampaignChild(campaign, child, node, taskIdFromSpec(retrySpec));
      await this.saveCampaign(campaign, generation);
      await this.dispatchReservedChild(campaign, child, node, retrySpec, generation);
      return true;
    } catch { return false; }
  }
  private async retryFromCheckpoint(campaign: CampaignRecord, child: CampaignRecord["children"][string], task: ControlTaskRecord, result: Record<string, unknown>, generation: number): Promise<boolean> { const checkpoint = implementationCheckpoint(result), node = campaign.plan?.nodes.find((item) => item.id === child.nodeId), attempt = (child.executionRetryAttempts ?? 0) + 1; if (!checkpoint || !node || task.status !== "awaiting_owner_decision" || !this.deps.repairTaskFromCheckpoint || attempt > 1) return false;
    const projected = this.taskSpecForNode(campaign, node), desiredRepair = Math.max(1, Math.floor(finiteNumber(object(object(object(projected.providerRouting).tokenBudget).perPhase).repair) ?? 1)), acceptedRepair = Math.max(0, Math.floor(finiteNumber(object(object(object(object(task.selection).budgets).tokenBudget).perPhase).repair) ?? desiredRepair)), repairIntent = `Repair only the failed validation or review after completed implementation for campaign node ${node.id}.`;
    const reservation = checkpointRepairReservation(node, desiredRepair); if (!withinRetryBudget(campaign, reservation)) return false; child.status = "pending"; child.accounted = false; child.executionRetryAttempts = attempt; child.finishedAt = null; child.error = null; child.checkpointRepair = { state: "pending", taskId: task.id, decisionId: `${campaign.id}_${node.id}_checkpoint_retry_${attempt}`, checkpointId: checkpoint.id, checkpointDigest: checkpoint.digest, additionalProviderTokens: acceptedRepair > 0 ? 0 : desiredRepair, repairIntent }; reserveCampaignChild(campaign, child, reservation, task.id); await this.saveCampaign(campaign, generation); return this.startPendingCheckpointRepair(campaign, child, generation);
  }
  private async startPendingCheckpointRepair(campaign: CampaignRecord, child: CampaignRecord["children"][string], generation: number): Promise<boolean> { const intent = child.checkpointRepair; if (!intent || intent.state !== "pending" || !this.deps.repairTaskFromCheckpoint) return false; try { await this.deps.repairTaskFromCheckpoint(intent.taskId, { taskId: intent.taskId, decisionId: intent.decisionId, checkpointId: intent.checkpointId, checkpointDigest: intent.checkpointDigest, choice: "retry_from_checkpoint", additionalProviderTokens: intent.additionalProviderTokens, repairIntent: intent.repairIntent }); intent.state = "started"; child.status = "running"; await this.saveCampaign(campaign, generation); return true; } catch { return false; } }
  private integrationFailure(campaign: CampaignRecord, child: CampaignRecord["children"][string], code: string): "failed" { const at = new Date().toISOString(); releaseCampaignReservation(campaign, child); child.status = "failed"; child.finishedAt = at; child.error = code; if (campaign.integration) { campaign.integration.status = "failed"; campaign.integration.lastError = code; } campaign.failures.push({ at, nodeId: child.nodeId, ...(child.taskId ? { taskId: child.taskId } : {}), reason: code }); return "failed"; } private async saveCampaign(campaign: CampaignRecord, generation: number): Promise<void> { this.assertCurrent(generation); await this.records.save(campaign, () => this.assertCurrent(generation)); }
  private readCampaign(id: string): Promise<CampaignRecord | null> { return this.records.read(id); } private readCampaigns(): Promise<CampaignRecord[]> { return this.records.list(); }
}
function implementationCheckpoint(result: Record<string, unknown>): { id: string; digest: string } | null { const workflow = object(result.workflow), implementation = object(result.implementation), checkpoints = Array.isArray(object(result.artifact).checkpoints) ? object(result.artifact).checkpoints : [], checkpoint = object(checkpoints.at(-1)); if (workflow.implementationCompleted !== true && !/^implemented/.test(String(implementation.status ?? "")) && !/^implementation(?:-|$)/.test(String(checkpoint.id ?? ""))) return null; return typeof checkpoint.id === "string" && typeof checkpoint.digest === "string" ? { id: checkpoint.id, digest: checkpoint.digest } : null; }
function checkpointRepairReservation(node: CampaignPlan["nodes"][number], tokens: number): CampaignPlan["nodes"][number] { const ratio = tokens / Math.max(1, node.estimatedTokens ?? tokens); return { ...node, estimatedTokens: tokens, ...(node.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: node.estimatedCostUsd * ratio }) }; }
function withinRetryBudget(campaign: CampaignRecord, node: CampaignPlan["nodes"][number]): boolean { return campaign.usage.tokens + reservedUsage(campaign).tokens + (node.estimatedTokens ?? 0) <= campaign.spec.limits.maxTokens && (campaign.spec.limits.maxCostUsd === undefined || campaign.usage.costUsd + reservedUsage(campaign).costUsd + (node.estimatedCostUsd ?? 0) <= campaign.spec.limits.maxCostUsd); }
