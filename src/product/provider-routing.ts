export const providerRoutingPhases = ["planner", "implementer", "repair", "reviewer"] as const;
export type ProviderRoutingPhase = typeof providerRoutingPhases[number];
const providerReasoningPhases = ["planner", "reviewer"] as const;
export type ProviderRoutingReasoningPhase = typeof providerReasoningPhases[number];
export type ProviderReasoning = { effort?: string; maxTokens?: number; exclude?: boolean };

export type ProviderRouting = {
  provider: "local" | "openrouter";
  fallbackPolicy: "none" | "same_provider";
  models: Partial<Record<ProviderRoutingPhase, string>>;
  maxCalls: number;
  tokenBudget: { total: number; perPhase: Record<ProviderRoutingPhase, number> };
  costBudgetUsd?: number;
  timeoutMs: number;
  retry: { maxAttempts: number };
  reasoning?: Partial<Record<ProviderRoutingReasoningPhase, ProviderReasoning>>;
};

export function normalizeProviderRouting(value: unknown, execution: { maxProviderTokens: number; timeoutMs: number }): ProviderRouting {
  if (value === undefined) return {
    provider: "local", fallbackPolicy: "none", models: {}, maxCalls: 4,
    tokenBudget: { total: execution.maxProviderTokens, perPhase: { planner: 10_000, implementer: 60_000, repair: 20_000, reviewer: 10_000 } },
    timeoutMs: execution.timeoutMs, retry: { maxAttempts: 1 }
  };
  const raw = object(value, "providerRouting must be an object.");
  rejectUnknown(raw, ["provider", "fallbackPolicy", "models", "reasoning", "maxCalls", "tokenBudget", "costBudgetUsd", "timeoutMs", "retry"], "providerRouting");
  const provider = choice(raw.provider, ["local", "openrouter"], "providerRouting.provider");
  const fallbackPolicy = choice(raw.fallbackPolicy ?? "none", ["none", "same_provider"], "providerRouting.fallbackPolicy");
  const modelsRaw = optionalObject(raw.models, "providerRouting.models");
  rejectUnknown(modelsRaw, [...providerRoutingPhases], "providerRouting.models");
  const models = Object.fromEntries(providerRoutingPhases.filter((phase) => modelsRaw[phase] !== undefined).map((phase) => [phase, string(modelsRaw[phase], `providerRouting.models.${phase}`)])) as ProviderRouting["models"];
  const budgetRaw = object(raw.tokenBudget, "providerRouting.tokenBudget must be an object.");
  rejectUnknown(budgetRaw, ["total", "perPhase"], "providerRouting.tokenBudget");
  const total = integer(budgetRaw.total, "providerRouting.tokenBudget.total", 1_000, 200_000, execution.maxProviderTokens);
  const perPhaseRaw = object(budgetRaw.perPhase, "providerRouting.tokenBudget.perPhase must be an object.");
  rejectUnknown(perPhaseRaw, [...providerRoutingPhases], "providerRouting.tokenBudget.perPhase");
  const perPhase = Object.fromEntries(providerRoutingPhases.map((phase) => [phase, integer(perPhaseRaw[phase], `providerRouting.tokenBudget.perPhase.${phase}`, 0, 200_000, 0)])) as ProviderRouting["tokenBudget"]["perPhase"];
  if (Object.values(perPhase).reduce((sum, budget) => sum + budget, 0) > total) throw new Error("providerRouting.tokenBudget.perPhase must not exceed providerRouting.tokenBudget.total.");
  const retryRaw = object(raw.retry, "providerRouting.retry must be an object.");
  rejectUnknown(retryRaw, ["maxAttempts"], "providerRouting.retry");
  const retry = { maxAttempts: integer(retryRaw.maxAttempts, "providerRouting.retry.maxAttempts", 1, 3, 1) };
  const reasoningRaw = optionalObject(raw.reasoning, "providerRouting.reasoning");
  rejectUnknown(reasoningRaw, [...providerReasoningPhases], "providerRouting.reasoning");
  const reasoning = Object.fromEntries(providerReasoningPhases.flatMap((phase) => {
    const entry = reasoningRaw[phase];
    if (entry === undefined) return [];
    const config = object(entry, `providerRouting.reasoning.${phase} must be an object.`);
    rejectUnknown(config, ["effort", "maxTokens", "exclude"], `providerRouting.reasoning.${phase}`);
    return [[phase, { ...(config.effort === undefined ? {} : { effort: string(config.effort, `providerRouting.reasoning.${phase}.effort`) }), ...(config.maxTokens === undefined ? {} : { maxTokens: integer(config.maxTokens, `providerRouting.reasoning.${phase}.maxTokens`, 1, 200_000, 1) }), ...(config.exclude === undefined ? {} : { exclude: boolean(config.exclude, `providerRouting.reasoning.${phase}.exclude`) }) }]];
  })) as ProviderRouting["reasoning"];
  if (fallbackPolicy === "same_provider" && retry.maxAttempts < 2) throw new Error("providerRouting.fallbackPolicy='same_provider' requires providerRouting.retry.maxAttempts of at least 2.");
  if (provider === "local" && fallbackPolicy !== "none") throw new Error("providerRouting.provider='local' only supports fallbackPolicy='none'.");
  if (provider === "local" && Object.keys(reasoning ?? {}).length > 0) throw new Error("providerRouting.reasoning is only supported when providerRouting.provider='openrouter'.");
  return { provider, fallbackPolicy, models, maxCalls: integer(raw.maxCalls, "providerRouting.maxCalls", 1, 32, 4), tokenBudget: { total, perPhase }, ...(raw.costBudgetUsd === undefined ? {} : { costBudgetUsd: finiteNumber(raw.costBudgetUsd, "providerRouting.costBudgetUsd", 0, 1_000) }), timeoutMs: integer(raw.timeoutMs, "providerRouting.timeoutMs", 1_000, execution.timeoutMs, execution.timeoutMs), retry, ...(Object.keys(reasoning ?? {}).length > 0 ? { reasoning } : {}) };
}

export function assertNoCredentialLikeKey(key: string, path: string): void {
  if (/^(?:password|passwd|secret|credential|api[_-]?key|access[_-]?token|auth[_-]?token|openrouter.*key)$/i.test(key)) throw new Error(`${path}.${key} is a credential-shaped field; TaskSpec must reference no credentials.`);
}

function object(value: unknown, message: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message); return value as Record<string, unknown>; }
function optionalObject(value: unknown, name: string): Record<string, unknown> { return value === undefined ? {} : object(value, `${name} must be an object.`); }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value.trim(); }
function integer(value: unknown, name: string, min: number, max: number, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || Number(parsed) < min || Number(parsed) > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`); return Number(parsed); }
function finiteNumber(value: unknown, name: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a finite number from ${min} to ${max}.`); return value; }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`); return value; }
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T { if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}.`); return value as T; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`${name} contains unknown field(s): ${unknown.join(", ")}.`); }
