import type { CampaignPlan, CampaignRecord } from "./contracts.js";

export function routingHasPhase(routing: Record<string, unknown>, phase: "repair" | "reviewer" | "logCompression"): boolean {
  const aliases = [`${phase}Route`, `${phase}ModelPool`, `${phase}Pool`];
  if (aliases.some((key) => routing[key] !== undefined)) return true;
  return ["models", "route", "routes", "phaseRoutes", "modelPool", "modelPools", "phaseModelPools", "pools"].some((key) => { const container = object(routing[key]); return Object.prototype.hasOwnProperty.call(container, phase) && container[phase] !== undefined; });
}

export function withoutRoutingPhase(routing: Record<string, unknown>, phase: "repair" | "reviewer" | "logCompression"): Record<string, unknown> {
  const adjusted = { ...routing };
  delete adjusted[`${phase}Route`]; delete adjusted[`${phase}ModelPool`]; delete adjusted[`${phase}Pool`];
  for (const key of ["models", "route", "routes", "phaseRoutes", "modelPool", "modelPools", "phaseModelPools", "pools"]) { const container = object(adjusted[key]); if (!Object.prototype.hasOwnProperty.call(container, phase)) continue; const next = { ...container }; delete next[phase]; adjusted[key] = next; }
  return adjusted;
}

export function projectPhaseBudgets(perPhase: Record<string, unknown>, total: number, implementation: boolean, compressionRoute: boolean, reviewerRoute: boolean, repairRoute: boolean): Record<string, number> {
  const desiredLog = compressionRoute ? Math.max(1, integer(perPhase.logCompression, 1)) : 0;
  const desiredReviewer = reviewerRoute ? Math.max(1, integer(perPhase.reviewer, 1)) : 0;
  const desiredRepair = repairRoute ? Math.max(1, integer(perPhase.repair, 1)) : 0;
  if (implementation) {
    const mandatoryOthers = (reviewerRoute ? 1 : 0) + (repairRoute ? 1 : 0), logCompression = Math.min(desiredLog, Math.max(0, total - 1 - mandatoryOthers));
    const reviewer = Math.min(desiredReviewer, Math.max(0, total - logCompression - 1 - (repairRoute ? 1 : 0))), repair = Math.min(desiredRepair, Math.max(0, total - logCompression - reviewer - 1));
    return { planner: 0, implementer: total - logCompression - reviewer - repair, repair, reviewer, logCompression };
  }
  const logCompression = Math.min(desiredLog, Math.max(0, total - (reviewerRoute ? 1 : 0) - (repairRoute ? 1 : 0))), reviewer = Math.min(desiredReviewer, Math.max(0, total - logCompression - (repairRoute ? 1 : 0))), repair = Math.min(desiredRepair, Math.max(0, total - logCompression - reviewer));
  const result: Record<string, number> = { repair, reviewer, logCompression }; let available = total - repair - reviewer - logCompression;
  for (const phase of ["planner", "implementer"] as const) { const allocated = Math.min(available, Math.max(0, integer(perPhase[phase], 0))); result[phase] = allocated; available -= allocated; }
  return result;
}

export function projectCampaignValidation(taskSpec: Record<string, unknown>, campaign: CampaignRecord, node: CampaignPlan["nodes"][number]): void {
  const required = campaign.spec.validationContract?.requiredCommands ?? [];
  const mode = object(taskSpec.execution).mode;
  const finalSink = mode === "validation" && !campaign.plan?.nodes.some((candidate) => candidate.dependsOn.includes(node.id));
  if (!required.length || (mode !== "implementation" && !finalSink)) return;
  const validation = object(taskSpec.validation), commands = [...new Set([...(Array.isArray(validation.commands) ? validation.commands.filter((item): item is string => typeof item === "string") : []), ...required])];
  const requiredSet = new Set(required), existing = Array.isArray(validation.requirements) ? validation.requirements : [], existingCommands = new Set(existing.map((value) => String(object(value).command ?? "")));
  const requirements = existing.map((value) => requiredSet.has(String(object(value).command ?? "")) ? { ...object(value), acceptance: "required" } : value);
  taskSpec.validation = { ...validation, mode: "explicit", commands, requirements: [...requirements, ...required.filter((command) => !existingCommands.has(command)).map((command) => ({ command, acceptance: "required" }))] };
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function integer(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback; }
