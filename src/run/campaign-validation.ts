import type { CampaignPlan, ControlAuthority } from "../control-plane/contracts.js";

export function detectCycle(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const visiting = new Set<string>(), visited = new Set<string>(), stack: string[] = [], graph = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const walk = (id: string): string[] => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return [];
    visiting.add(id); stack.push(id);
    for (const dep of graph.get(id) ?? []) { const found = walk(dep); if (found.length) return found; }
    stack.pop(); visiting.delete(id); visited.add(id); return [];
  };
  for (const node of nodes) { const cycle = walk(node.id); if (cycle.length) return cycle; }
  return [];
}

export function topoSortPlan(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const deps = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)])), ready = [...nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)], ordered: string[] = [];
  while (ready.length) { const id = ready.shift()!; ordered.push(id); for (const [otherId, otherDeps] of deps) if (otherDeps.delete(id) && otherDeps.size === 0) ready.push(otherId); }
  return ordered;
}

export function validateCampaignPlan(plan: CampaignPlan, limits: { maxTasks: number; maxTokens: number; maxCostUsd?: number }, authority: ControlAuthority, options: { requireOpenRouter: boolean }): void {
  if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error("campaign plan must include at least one node.");
  if (plan.nodes.length > limits.maxTasks) throw new Error("campaign plan exceeds maxTasks.");
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate campaign node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) if (!ids.has(dep)) throw new Error(`campaign dependency is missing: ${dep}`);
    const task = node.taskSpec as Record<string, any>, taskAuthority = task.authority ?? {};
    if (taskAuthority.allowProviderCalls && authority.providerCalls !== true) throw new Error(`campaign authority expansion rejected for node ${node.id}: providerCalls`);
    if (taskAuthority.allowNetwork && authority.network !== true) throw new Error(`campaign authority expansion rejected for node ${node.id}: network`);
    if (object(task.merge).policy && object(task.merge).policy !== "never") throw new Error(`dangerous phase requested in node ${node.id}: merge`);
    if (object(task.deploy).policy && object(task.deploy).policy !== "never") throw new Error(`dangerous phase requested in node ${node.id}: deploy`);
    if (object(task.git).publication && object(task.git).publication !== "none") throw new Error(`dangerous phase requested in node ${node.id}: publication`);
    const text = JSON.stringify(task).toLowerCase();
    if (/\b(?:database|production|secret|merge|deploy)\b/.test(text) && /\bpolicy"\s*:\s*"always|requested"\s*:\s*true/.test(text)) throw new Error(`dangerous requested phase in node ${node.id}`);
    if (options.requireOpenRouter) { const route = object(task.providerRouting); if (route.provider !== "openrouter") throw new Error(`openrouter campaign node ${node.id} attempted local provider.`); if ((route.fallbackPolicy ?? "none") !== "none") throw new Error(`openrouter campaign node ${node.id} attempted fallback expansion.`); }
  }
  const cycle = detectCycle(plan.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn }))); if (cycle.length) throw new Error(`campaign plan has cycle: ${cycle.join(" -> ")}`);
  const estimatedTokens = plan.nodes.reduce((total, node) => total + (node.estimatedTokens ?? 0), 0); if (estimatedTokens > limits.maxTokens) throw new Error("campaign token budget exceeded by planned estimate.");
  const estimatedCost = plan.nodes.reduce((total, node) => total + (node.estimatedCostUsd ?? 0), 0); if (limits.maxCostUsd !== undefined && estimatedCost > limits.maxCostUsd) throw new Error("campaign cost budget exceeded by planned estimate.");
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
