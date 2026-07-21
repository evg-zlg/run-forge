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

export function validateCampaignPlan(plan: CampaignPlan, limits: { maxTasks: number; maxTokens: number; maxCostUsd?: number }, authority: ControlAuthority, options: { requireOpenRouter: boolean; implementation?: boolean; requiredValidationCommands?: string[] }): void {
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
    if (limits.maxCostUsd !== undefined && object(task.providerRouting).provider === "openrouter") {
      const childCap = object(task.providerRouting).costBudgetUsd;
      if (!finiteNonNegative(node.estimatedCostUsd)) throw new Error(`campaign node ${node.id} requires a finite cost estimate.`);
      if (!finiteNonNegative(childCap)) throw new Error(`campaign node ${node.id} requires a finite child cost cap.`);
      if (Number(childCap) > Number(node.estimatedCostUsd)) throw new Error(`campaign node ${node.id} child cost cap exceeds its estimate.`);
    }
  }
  const cycle = detectCycle(plan.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn }))); if (cycle.length) throw new Error(`campaign plan has cycle: ${cycle.join(" -> ")}`);
  const estimatedTokens = plan.nodes.reduce((total, node) => total + (node.estimatedTokens ?? 0), 0); if (estimatedTokens > limits.maxTokens) throw new Error("campaign token budget exceeded by planned estimate.");
  const estimatedCost = plan.nodes.reduce((total, node) => total + (node.estimatedCostUsd ?? 0), 0);
  if (limits.maxCostUsd !== undefined) {
    if (!finiteNonNegative(plan.estimatedCostUsd)) throw new Error("campaign plan requires a finite cost estimate.");
    if (Math.abs(Number(plan.estimatedCostUsd) - estimatedCost) > 0.000_001) throw new Error("campaign plan cost estimate must equal its node estimates.");
    if (estimatedCost > limits.maxCostUsd) throw new Error("campaign cost budget exceeded by planned estimate.");
  }
  if (options.implementation) validateImplementationSinks(plan, options.requiredValidationCommands ?? []);
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function finiteNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validateImplementationSinks(plan: CampaignPlan, requiredCommands: string[]): void {
  const dependedOn = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  const sinks = plan.nodes.filter((node) => !dependedOn.has(node.id));
  const implementations = plan.nodes.filter((node) => object(node.taskSpec).execution?.mode === "implementation");
  if (!implementations.length) throw new Error("implementation campaign plan requires at least one implementation node.");
  if (sinks.length !== 1) throw new Error("implementation campaign plan requires exactly one global terminal validation sink.");
  const commands = new Set<string>();
  const requirementAcceptances = new Map<string, string[]>();
  for (const node of sinks) {
    const task = object(node.taskSpec), execution = object(task.execution), authority = object(task.authority), discovery = object(task.discovery), validation = object(task.validation);
    const scopes = [...(node.writeScopes ?? []), ...(Array.isArray(discovery.writeScopes) ? discovery.writeScopes : [])];
    if (execution.mode !== "validation" || authority.profile !== "read-only" || authority.allowProviderCalls === true || authority.allowNetwork === true || scopes.length) throw new Error(`implementation campaign terminal node ${node.id} must be validation-only and read-only.`);
    if (validation.mode !== "explicit" || !Array.isArray(validation.commands)) throw new Error(`implementation campaign terminal node ${node.id} requires explicit validation commands.`);
    for (const command of validation.commands) if (typeof command === "string") commands.add(command);
    if (!Array.isArray(validation.requirements)) throw new Error(`implementation campaign terminal node ${node.id} requires explicit validation requirements.`);
    for (const requirement of validation.requirements) { const item = object(requirement); if (typeof item.command === "string") requirementAcceptances.set(item.command, [...(requirementAcceptances.get(item.command) ?? []), String(item.acceptance ?? "default")]); }
    const ancestors = transitiveDependencies(node.id, new Map(plan.nodes.map((item) => [item.id, item.dependsOn])));
    for (const implementation of implementations) if (!ancestors.has(implementation.id)) throw new Error(`global terminal validation sink must depend on implementation node ${implementation.id}.`);
  }
  for (const command of requiredCommands) {
    if (!commands.has(command)) throw new Error(`campaign final validation sinks omit required command: ${command}`);
    if (!strictlyRequired(requirementAcceptances.get(command))) throw new Error(`campaign final validation command must have required acceptance: ${command}`);
  }
  const integrity = [...commands].find((command) => /^git diff --check (?:__CAMPAIGN_BASE__|[a-f0-9]{40,64})\.\.\.HEAD$/.test(command));
  if (!integrity) throw new Error("campaign final validation sinks require a meaningful campaign Git diff range.");
  if (!strictlyRequired(requirementAcceptances.get(integrity))) throw new Error("campaign Git integrity requirement must have required acceptance.");
}
function transitiveDependencies(id: string, graph: Map<string, string[]>, seen = new Set<string>()): Set<string> { for (const dependency of graph.get(id) ?? []) if (!seen.has(dependency)) { seen.add(dependency); transitiveDependencies(dependency, graph, seen); } return seen; }
function strictlyRequired(values: string[] | undefined): boolean { return values !== undefined && values.length > 0 && values.every((value) => value === "required"); }
