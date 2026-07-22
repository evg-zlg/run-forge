import { createHash } from "node:crypto";

export const providerRoutingPhases = ["planner", "implementer", "repair", "reviewer", "logCompression"] as const;
export type ProviderRoutingPhase = typeof providerRoutingPhases[number];
const providerReasoningPhases = ["planner", "reviewer"] as const;
export type ProviderRoutingReasoningPhase = typeof providerReasoningPhases[number];
export type ProviderReasoning = { effort?: string; maxTokens?: number; exclude?: boolean };
export type ProviderModelPools = Partial<Record<ProviderRoutingPhase, string[]>>;

/**
 * Ordered working candidates. They are opt-in: legacy `models` stays the
 * compatibility path until a caller explicitly supplies `modelPools`.
 */
export const defaultOpenRouterModelPools: Readonly<Record<ProviderRoutingPhase, readonly string[]>> = {
  planner: ["z-ai/glm-5.2", "moonshotai/kimi-k3", "qwen/qwen3.7-max"],
  implementer: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "openai/gpt-5.3-codex"],
  repair: ["deepseek/deepseek-v4-flash", "z-ai/glm-4.7-flash"],
  reviewer: ["moonshotai/kimi-k3", "z-ai/glm-5.2", "openai/gpt-5.6-terra"],
  logCompression: ["z-ai/glm-4.7-flash", "deepseek/deepseek-v4-flash", "google/gemini-3.5-flash-lite"],
};
const legacyLogCompressionBudget = 1_000;

export type ProviderRouting = {
  provider: "local" | "openrouter";
  fallbackPolicy: "none" | "same_provider";
  /** Legacy single-model routes. A model pool for the same phase takes precedence. */
  models: Partial<Record<ProviderRoutingPhase, string>>;
  /** Ordered candidates; selection is stable for a caller-provided key. */
  modelPools?: ProviderModelPools;
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
    tokenBudget: { total: execution.maxProviderTokens, perPhase: { planner: 10_000, implementer: 60_000, repair: 20_000, reviewer: 10_000, logCompression: 0 } },
    timeoutMs: execution.timeoutMs, retry: { maxAttempts: 1 }
  };
  const raw = object(value, "providerRouting must be an object.");
  rejectUnknown(raw, ["provider", "fallbackPolicy", "models", "modelPools", "reasoning", "maxCalls", "tokenBudget", "costBudgetUsd", "timeoutMs", "retry"], "providerRouting");
  const provider = choice(raw.provider, ["local", "openrouter"], "providerRouting.provider");
  const fallbackPolicy = choice(raw.fallbackPolicy ?? "none", ["none", "same_provider"], "providerRouting.fallbackPolicy");
  const modelsRaw = optionalObject(raw.models, "providerRouting.models");
  rejectUnknown(modelsRaw, [...providerRoutingPhases], "providerRouting.models");
  const models = Object.fromEntries(providerRoutingPhases.filter((phase) => modelsRaw[phase] !== undefined).map((phase) => [phase, string(modelsRaw[phase], `providerRouting.models.${phase}`)])) as ProviderRouting["models"];
  const modelPools = normalizeProviderModelPools(raw.modelPools, "providerRouting.modelPools");
  const budgetRaw = object(raw.tokenBudget, "providerRouting.tokenBudget must be an object.");
  rejectUnknown(budgetRaw, ["total", "perPhase"], "providerRouting.tokenBudget");
  const total = integer(budgetRaw.total, "providerRouting.tokenBudget.total", 1_000, 200_000, execution.maxProviderTokens);
  const perPhaseRaw = object(budgetRaw.perPhase, "providerRouting.tokenBudget.perPhase must be an object.");
  rejectUnknown(perPhaseRaw, [...providerRoutingPhases], "providerRouting.tokenBudget.perPhase");
  const perPhase = Object.fromEntries(providerRoutingPhases.map((phase) => [phase, integer(perPhaseRaw[phase], `providerRouting.tokenBudget.perPhase.${phase}`, 0, 200_000, 0)])) as ProviderRouting["tokenBudget"]["perPhase"];
  materializeLegacyLogCompressionRoute(provider, models, modelPools, perPhase, total);
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
  return { provider, fallbackPolicy, models, ...(Object.keys(modelPools).length ? { modelPools } : {}), maxCalls: integer(raw.maxCalls, "providerRouting.maxCalls", 1, 32, 4), tokenBudget: { total, perPhase }, ...(raw.costBudgetUsd === undefined ? {} : { costBudgetUsd: finiteNumber(raw.costBudgetUsd, "providerRouting.costBudgetUsd", 0, 1_000) }), timeoutMs: integer(raw.timeoutMs, "providerRouting.timeoutMs", 1_000, execution.timeoutMs, execution.timeoutMs), retry, ...(Object.keys(reasoning ?? {}).length > 0 ? { reasoning } : {}) };
}

/**
 * Old four-phase OpenRouter TaskSpecs predate the mandatory raw-log boundary.
 * Preserve their usable route by reserving a small cheap compression lane from
 * an existing implementation budget; reject only when no honest reservation
 * can be made instead of silently sending raw logs to a legacy model.
 */
function materializeLegacyLogCompressionRoute(provider: "local" | "openrouter", models: ProviderRouting["models"], modelPools: ProviderModelPools, perPhase: ProviderRouting["tokenBudget"]["perPhase"], total: number): void {
  if (provider !== "openrouter") return;
  if (modelPools.logCompression || models.logCompression) {
    if (perPhase.logCompression <= 0) throw new Error("providerRouting.tokenBudget.perPhase.logCompression must be positive when a logCompression route is configured.");
    return;
  }
  const hasLegacyWorkRoute = ["planner", "implementer", "repair", "reviewer"].some((phase) => models[phase as Exclude<ProviderRoutingPhase, "logCompression">] !== undefined || modelPools[phase as Exclude<ProviderRoutingPhase, "logCompression">]?.length);
  if (!hasLegacyWorkRoute) return;
  const used = Object.values(perPhase).reduce((sum, budget) => sum + budget, 0);
  const room = total - used;
  if (perPhase.logCompression >= legacyLogCompressionBudget) {
    models.logCompression = defaultOpenRouterModelPools.logCompression[0];
    modelPools.logCompression = [...defaultOpenRouterModelPools.logCompression];
    return;
  }
  const required = legacyLogCompressionBudget - perPhase.logCompression;
  const donor = (["implementer", "repair", "planner", "reviewer"] as const)
    .map((phase) => ({ phase, budget: perPhase[phase] }))
    .find((item) => item.budget >= Math.max(0, required - room));
  if (room < required && !donor) throw new Error("providerRouting legacy four-phase migration requires a 1000-token logCompression budget; increase providerRouting.tokenBudget.total or reduce a phase budget.");
  if (room < required) perPhase[donor!.phase] -= required - Math.max(0, room);
  perPhase.logCompression = legacyLogCompressionBudget;
  models.logCompression = defaultOpenRouterModelPools.logCompression[0];
  modelPools.logCompression = [...defaultOpenRouterModelPools.logCompression];
}

/** Parse a phase-keyed ordered model pool without selecting a model. */
export function normalizeProviderModelPools(value: unknown, name = "providerRouting.modelPools"): ProviderModelPools {
  const raw = optionalObject(value, name);
  rejectUnknown(raw, [...providerRoutingPhases], name);
  const result: ProviderModelPools = {};
  for (const phase of providerRoutingPhases) {
    if (raw[phase] === undefined) continue;
    if (!Array.isArray(raw[phase]) || !raw[phase].length) throw new Error(`${name}.${phase} must be a non-empty array.`);
    const candidates = raw[phase].map((candidate, index) => string(candidate, `${name}.${phase}[${index}]`));
    if (new Set(candidates).size !== candidates.length) throw new Error(`${name}.${phase} must not contain duplicate models.`);
    result[phase] = candidates;
  }
  return result;
}

export type ProviderModelSelection = { phase: ProviderRoutingPhase; model: string; source: "model_pool" | "legacy_model"; index: number; poolSize: number };

/**
 * Choose one ordered candidate deterministically. Persist the caller's stable
 * key with the task/campaign so retries and recovery never re-roll a model.
 */
export function selectProviderModel(routing: Pick<ProviderRouting, "models" | "modelPools">, phase: ProviderRoutingPhase, stableKey: string): ProviderModelSelection | null {
  if (!stableKey.trim()) throw new Error("provider routing selection requires a non-empty stable key.");
  const pool = routing.modelPools?.[phase];
  if (pool?.length) {
    const index = createHash("sha256").update(`${phase}\u0000${stableKey}`).digest().readUInt32BE(0) % pool.length;
    return { phase, model: pool[index]!, source: "model_pool", index, poolSize: pool.length };
  }
  const model = routing.models[phase];
  return model === undefined ? null : { phase, model, source: "legacy_model", index: 0, poolSize: 1 };
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
