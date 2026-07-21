import type { CampaignPlannerEvidence } from "../run/semantic-campaign-planner.js";
import { ControlPlaneError, type CampaignPlan, type CampaignRecord } from "./contracts.js";
import { boundPublicResult } from "./manager-results.js";

export function aggregateCampaignUsage(value: unknown): { tokens: number; costUsd: number } { const root = object(value), result = object(root.result && typeof root.result === "object" ? root.result : root), usage = object(result.usage), calls = Array.isArray(result.providerCalls) ? result.providerCalls.map(object) : []; return { tokens: finiteNumber(usage.totalTokens) ?? calls.reduce((sum, call) => sum + (finiteNumber(call.tokenUsage) ?? 0), 0), costUsd: finiteNumber(usage.costUsd) ?? calls.reduce((sum, call) => sum + (finiteNumber(call.costUsd) ?? 0), 0) }; }
/**
 * Child completion is deliberately mode-aware. An implementation executor can
 * finish its bounded patch while a nested task workflow remains open for an
 * independent external review. The campaign owns that follow-up by applying
 * the patch and running its terminal validation sink, so it must not discard a
 * proven implementation merely because the nested workflow is awaiting that
 * review. Validation nodes, on the other hand, may only advance on a complete
 * workflow result.
 */
export function campaignChildCompletion(value: unknown, executionMode?: string): { completed: boolean; reason: string } {
  const root = object(value), result = object(root.result && typeof root.result === "object" ? root.result : root), workflow = object(result.workflow), status = typeof result.status === "string" ? result.status : "unknown", workflowStatus = typeof workflow.status === "string" ? workflow.status : undefined, workflowCompleted = result.workflowCompleted === true || workflow.workflowCompleted === true, verdict = String(result.verdict ?? workflow.verdict ?? "").toLowerCase(), rootVerdict = String(result.verdict ?? "").toLowerCase(), workflowVerdict = String(workflow.verdict ?? "").toLowerCase(), validationAggregate = String(result.validationAggregate ?? workflow.validationAggregate ?? ""), next = object(result.next ?? result.nextAction ?? workflow.next ?? workflow.nextAction), nextParty = typeof next.party === "string" ? next.party : null;
  const fatalStatus = (candidate: string | undefined): boolean => ["failed", "blocked", "blocked_by_capability", "blocked_by_policy", "cancelled", "timed_out"].includes(candidate ?? "");
  const fatalVerdict = (candidate: string): boolean => ["failed", "blocked", "rejected", "do_not_apply"].includes(candidate);
  const fatal = (): { completed: false; reason: string } | null => {
    if (fatalStatus(status)) return { completed: false, reason: `campaign_child_workflow_fatal:${status}` };
    if (fatalStatus(workflowStatus)) return { completed: false, reason: `campaign_child_workflow_fatal:${workflowStatus}` };
    if (fatalVerdict(rootVerdict)) return { completed: false, reason: `campaign_child_verdict:${rootVerdict}` };
    if (fatalVerdict(workflowVerdict)) return { completed: false, reason: `campaign_child_verdict:${workflowVerdict}` };
    return null;
  };
  const fatalCompletion = fatal();
  if (fatalCompletion) return fatalCompletion;
  if (executionMode === "implementation") {
    const implementation = object(result.implementation), implementationStatus = typeof implementation.status === "string" ? implementation.status : "unknown";
    if (status !== "completed") return { completed: false, reason: `campaign_child_implementation_incomplete:${status}` };
    if (implementationStatus === "implemented_and_validated") return { completed: true, reason: "" };
    if (implementationStatus === "no_change_required") return { completed: false, reason: "campaign_child_implementation_no_change_requires_explicit_noop_contract" };
    return { completed: false, reason: `campaign_child_implementation_incomplete:${implementationStatus}` };
  }
  if (executionMode === "validation") {
    const incompleteStatus = workflowStatus ?? status;
    const settled = status === "workflow_completed" || (status === "completed" && workflowStatus === "workflow_completed");
    if (!settled) return { completed: false, reason: `campaign_child_workflow_incomplete:${incompleteStatus}${nextParty ? `:${nextParty}` : ""}` };
    return ["passed", "completed_with_validation_gaps"].includes(validationAggregate)
      ? { completed: true, reason: "" }
      : { completed: false, reason: `campaign_child_validation_incomplete:${validationAggregate || "unknown"}` };
  }
  if (["awaiting_external_session", "runforge_scope_completed", "awaiting_owner", "awaiting_owner_decision", "blocked"].includes(status) || ["awaiting_external_session", "runforge_scope_completed", "awaiting_owner", "blocked"].includes(workflowStatus ?? "")) return { completed: false, reason: `campaign_child_workflow_incomplete:${workflowStatus ?? status}` };
  if (result.workflowCompleted === false || workflow.workflowCompleted === false) return { completed: false, reason: "campaign_child_workflow_incomplete:workflowCompleted_false" };
  if (fatalVerdict(verdict)) return { completed: false, reason: `campaign_child_verdict:${verdict}` };
  if (status === "workflow_completed" || (status === "completed" && workflowStatus === "workflow_completed") || (workflowCompleted && status === "completed")) return { completed: true, reason: "" };
  return { completed: false, reason: `campaign_child_workflow_incomplete:${status}${nextParty ? `:${nextParty}` : ""}` };
}
export function usageFromEvidence(value: Record<string, unknown> | CampaignPlannerEvidence | null): { tokens: number; costUsd: number } { const usage = value && typeof value.usage === "object" && value.usage !== null ? value.usage as Record<string, unknown> : {}; return { tokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : 0, costUsd: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : 0 }; }
export function reservedUsage(campaign: CampaignRecord): { tokens: number; costUsd: number } { const persisted = object(campaign.reserved), tokens = finiteNumber(persisted.tokens), costUsd = finiteNumber(persisted.costUsd); if (tokens !== null && costUsd !== null) return { tokens: Math.max(0, tokens), costUsd: Math.max(0, costUsd) }; return Object.values(campaign.children).reduce((total, child) => ({ tokens: total.tokens + Math.max(0, finiteNumber(child.reservedTokens) ?? 0), costUsd: total.costUsd + Math.max(0, finiteNumber(child.reservedCostUsd) ?? 0) }), { tokens: 0, costUsd: 0 }); }
export function childReservationTokens(campaign: CampaignRecord, nodeId: string): number { return Math.max(0, finiteNumber(campaign.children[nodeId]?.reservedTokens) ?? 0); }
export function taskIdFromSpec(taskSpec: Record<string, unknown>): string | null { const id = taskSpec.taskId; return typeof id === "string" && id.trim() ? id : null; }
export function reserveCampaignChild(campaign: CampaignRecord, child: CampaignRecord["children"][string], node: CampaignPlan["nodes"][number], taskId: string | null): void {
  if (!taskId) throw new ControlPlaneError(422, "invalid_campaign", `Campaign node '${node.id}' has no deterministic taskSpec.taskId.`);
  if (child.status !== "pending") throw new ControlPlaneError(409, "campaign_child_not_pending", `Campaign child '${node.id}' is already ${child.status}.`);
  const tokens = Math.max(0, finiteNumber(node.estimatedTokens) ?? 0), costUsd = Math.max(0, finiteNumber(node.estimatedCostUsd) ?? 0);
  Object.assign(child, { taskId, status: "dispatching", startedAt: new Date().toISOString(), finishedAt: null, error: null, reservedTokens: tokens, reservedCostUsd: costUsd });
  campaign.reserved = reservedUsage(campaign); campaign.reserved.tokens += tokens; campaign.reserved.costUsd += costUsd;
}
export function releaseCampaignReservation(campaign: CampaignRecord, child: CampaignRecord["children"][string]): void {
  campaign.reserved = reservedUsage(campaign);
  campaign.reserved.tokens = Math.max(0, campaign.reserved.tokens - Math.max(0, finiteNumber(child.reservedTokens) ?? 0));
  campaign.reserved.costUsd = Math.max(0, campaign.reserved.costUsd - Math.max(0, finiteNumber(child.reservedCostUsd) ?? 0));
  child.reservedTokens = 0; child.reservedCostUsd = 0;
}
export function accountCampaignChildUsage(campaign: CampaignRecord, child: CampaignRecord["children"][string], result: Record<string, unknown>): void {
  const usage = aggregateCampaignUsage(result); campaign.usage.tokens += usage.tokens; campaign.usage.costUsd += usage.costUsd; campaign.usage.tasks += 1;
  child.evidence = boundPublicResult(result).result; child.accounted = true; releaseCampaignReservation(campaign, child);
}
export function deterministicPlannerEvidence(): CampaignPlannerEvidence { return { mode: "deterministic-local", model: null, attempts: 0, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: [] }; }
export function failedPlannerEvidence(): CampaignPlannerEvidence { return { mode: "semantic-openrouter", model: null, attempts: 0, repaired: false, usage: { tokens: 0, costUsd: 0 }, validationCodes: ["PLANNER_FAILED"] }; }
export function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
export function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function reconcileCampaignResult(campaign: CampaignRecord): Record<string, unknown> { const contract = campaign.spec.validationContract, contractKnown = Boolean(contract?.requiredCommands.length); return { schemaVersion: 1, campaignId: campaign.id, status: campaign.status, usage: campaign.usage, reserved: reservedUsage(campaign), failures: campaign.failures, integration: campaign.integration, validation: { contract: contractKnown ? { status: "known", source: contract!.source, requiredCommands: contract!.requiredCommands } : { status: "unknown", requiredCommands: [] }, completion: campaign.status === "completed" ? "satisfied" : !contractKnown && campaign.spec.authority.implementation ? "blocked" : "not_completed" }, children: Object.values(campaign.children).map((child) => ({ nodeId: child.nodeId, taskId: child.taskId, status: child.status, startedAt: child.startedAt, finishedAt: child.finishedAt, error: child.error, integrationRepairAttempts: child.integrationRepairAttempts ?? 0, executionRetryAttempts: child.executionRetryAttempts ?? 0 })), evidence: Object.values(campaign.children).filter((child) => child.evidence).map((child) => ({ nodeId: child.nodeId, evidence: child.evidence })) }; }
