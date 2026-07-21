import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectCycle, validateCampaignPlan } from "../run/task-run-planner.js";
import { SemanticCampaignPlannerError, type CampaignPlannerEvidence, type SemanticCampaignPlannerResult } from "../run/semantic-campaign-planner.js";
import { boundPublicResult } from "./manager-results.js";
import { ControlPlaneError, type CampaignPlan, type CampaignRecord, type CampaignSpec, type ControlTaskRecord } from "./contracts.js";

type Deps = {
  root: string;
  planCampaign: (record: CampaignRecord) => Promise<CampaignPlan | SemanticCampaignPlannerResult>;
  createTask: (input: { projectId?: string; taskSpec: Record<string, unknown>; authority: CampaignSpec["authority"]; publicationRequested: "none" | "draft-pr" }) => Promise<ControlTaskRecord>;
  getTask: (id: string) => Promise<ControlTaskRecord>;
  getResult: (id: string) => Promise<Record<string, unknown>>;
};

export class CampaignCoordinator {
  private readonly activeCampaignLoops = new Map<string, Promise<void>>();
  constructor(private readonly deps: Deps) {}
  async initialize(): Promise<void> { for (const campaign of await this.readCampaigns()) if (["planning", "queued", "running"].includes(campaign.status)) this.ensureCampaignLoop(campaign.id); }
  close(): void { this.activeCampaignLoops.clear(); }
  async createCampaign(spec: CampaignSpec): Promise<CampaignRecord> {
    if (!spec.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a campaign.");
    if (spec.authority.implementation && !spec.authority.providerCalls) throw new ControlPlaneError(403, "authority_denied", "Campaign authority expansion rejected: implementation requires providerCalls authority.");
    if (spec.providerRouting.provider === "openrouter" && spec.providerRouting.fallbackPolicy && spec.providerRouting.fallbackPolicy !== "none") throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter campaigns must set fallbackPolicy='none'.");
    const now = new Date().toISOString();
    const id = `cmp_v1_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const record: CampaignRecord = { schemaVersion: 1, id, status: "planning", spec, plan: null, plannerEvidence: null, children: {}, usage: { tokens: 0, costUsd: 0, tasks: 0 }, checkpoints: [], failures: [], result: null, createdAt: now, updatedAt: now };
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
    record.children = Object.fromEntries(plan.nodes.map((node) => [node.id, { nodeId: node.id, dependsOn: node.dependsOn, taskId: null, status: "pending", startedAt: null, finishedAt: null, error: null, accounted: false }]));
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
    const loop = this.runCampaign(id).finally(() => this.activeCampaignLoops.delete(id));
    this.activeCampaignLoops.set(id, loop);
  }
  private async runCampaign(id: string): Promise<void> {
    while (true) {
      const campaign = await this.readCampaign(id);
      if (!campaign || !campaign.plan || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
      campaign.status = "running";
      let progressed = false;
      for (const child of Object.values(campaign.children)) {
        if (!child.taskId || !["queued", "running"].includes(child.status)) continue;
        const task = await this.deps.getTask(child.taskId).catch(() => null);
        if (!task) continue;
        if (task.status === "completed") {
          child.status = "completed";
          child.finishedAt = new Date().toISOString();
          progressed = true;
          if (!child.accounted) {
            const result = await this.deps.getResult(child.taskId).catch(() => ({}));
            const usage = aggregateUsageFromValue(result);
            campaign.usage.tokens += usage.tokens;
            campaign.usage.costUsd += usage.costUsd;
            child.evidence = boundPublicResult(result).result;
            child.accounted = true;
            campaign.usage.tasks += 1;
          }
        } else if (["failed", "interrupted"].includes(task.status)) {
          child.status = "failed";
          child.finishedAt = new Date().toISOString();
          child.error = task.error ?? "child_failed";
          campaign.status = "failed";
          campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, taskId: child.taskId, reason: child.error });
        } else child.status = "running";
      }
      if (campaign.status === "failed") return this.finishCampaign(campaign, "failed");
      if (campaign.usage.tokens > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd > campaign.spec.limits.maxCostUsd)) {
        campaign.status = "failed";
        campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" });
        return this.finishCampaign(campaign, "failed");
      }
      const activeChildren = Object.values(campaign.children).filter((item) => ["queued", "running"].includes(item.status)).length;
      const slots = Math.max(0, campaign.spec.limits.maxConcurrency - activeChildren);
      if (slots > 0) {
        const ready = campaign.plan.nodes.filter((node) => {
          const child = campaign.children[node.id];
          if (!child || child.status !== "pending") return false;
          return node.dependsOn.every((dep) => campaign.children[dep]?.status === "completed");
        }).slice(0, slots);
        for (const node of ready) {
          if (campaign.usage.tokens + (node.estimatedTokens ?? 0) > campaign.spec.limits.maxTokens || (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd + (node.estimatedCostUsd ?? 0) > campaign.spec.limits.maxCostUsd)) {
            campaign.status = "failed";
            campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" });
            return this.finishCampaign(campaign, "failed");
          }
          const child = campaign.children[node.id]!;
          const task = await this.deps.createTask({ ...(campaign.spec.target.projectId ? { projectId: campaign.spec.target.projectId } : {}), taskSpec: node.taskSpec, authority: campaign.spec.authority, publicationRequested: "none" });
          child.taskId = task.id;
          child.status = task.status === "queued" ? "queued" : "running";
          child.startedAt = new Date().toISOString();
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
        if (task && ["completed", "failed", "interrupted"].includes(task.status)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  private async finishCampaign(campaign: CampaignRecord, status: CampaignRecord["status"]): Promise<void> {
    campaign.status = status;
    campaign.result = reconcileCampaignResult(campaign);
    campaign.updatedAt = new Date().toISOString();
    await this.saveCampaign(campaign);
  }
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

function aggregateUsageFromValue(value: unknown): { tokens: number; costUsd: number } { const totals = { tokens: 0, costUsd: 0 }; const visit = (current: unknown): void => { if (Array.isArray(current)) current.forEach(visit); else if (current && typeof current === "object") for (const [key, entry] of Object.entries(current as Record<string, unknown>)) { if (typeof entry === "number" && Number.isFinite(entry) && /(token|tokens|tokenUsage|totalTokens)/i.test(key)) totals.tokens += entry; else if (typeof entry === "number" && Number.isFinite(entry) && /(cost|costUsd|usd)/i.test(key)) totals.costUsd += entry; else visit(entry); } }; visit(value); return totals; }
function usageFromEvidence(value: Record<string, unknown> | CampaignPlannerEvidence | null): { tokens: number; costUsd: number } { const usage = value && typeof value.usage === "object" && value.usage !== null ? value.usage as Record<string, unknown> : {}; return { tokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : 0, costUsd: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : 0 }; }
function deterministicPlannerEvidence(): CampaignPlannerEvidence { return { mode: "deterministic-local", model: null, attempts: 0, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: [] }; }
function failedPlannerEvidence(): CampaignPlannerEvidence { return { mode: "semantic-openrouter", model: null, attempts: 0, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: ["PLANNER_FAILED"] }; }
function reconcileCampaignResult(campaign: CampaignRecord): Record<string, unknown> { return { schemaVersion: 1, campaignId: campaign.id, status: campaign.status, usage: campaign.usage, failures: campaign.failures, children: Object.values(campaign.children).map((child) => ({ nodeId: child.nodeId, taskId: child.taskId, status: child.status, startedAt: child.startedAt, finishedAt: child.finishedAt, error: child.error })), evidence: Object.values(campaign.children).filter((child) => child.evidence).map((child) => ({ nodeId: child.nodeId, evidence: child.evidence })) }; }
