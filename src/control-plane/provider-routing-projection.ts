import type { ImplementationExecutorCapability } from "../implementation/executor.js";

type Executor = ImplementationExecutorCapability;

export function providerForExecutor(executor: unknown): "local" | "openrouter" | null {
  if (!executor || typeof executor !== "object") return null;
  const value = executor as Record<string, unknown>;
  return value.provider === "openrouter" || value.id === "openrouter-coding-agent" ? "openrouter" : value.provider === "local" || typeof value.id === "string" ? "local" : null;
}

export function openRouterReadiness(): { configured: boolean; credentialReady: boolean; ready: boolean; noLocalFallback: true } {
  // This intentionally returns only booleans. Do not reveal a reference, value, or header.
  const credentialReady = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return { configured: credentialReady, credentialReady, ready: credentialReady, noLocalFallback: true };
}

export function publicImplementationExecutors(executors: Executor[]): Record<string, unknown>[] {
  const listed = executors.map((item) => ({
    id: item.id, provider: providerForExecutor(item), status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime,
    providerRequirements: item.providerRequirements, networkRequirements: item.networkRequirements, maxLimits: item.maxLimits, limitations: item.status === "ready" ? [] : ["Implementation executor or its existing credential mechanism is not ready."], model: item.model,
    credentialReady: item.status === "ready", credentialReason: item.status === "ready" ? "Existing credential mechanism is ready." : "Existing credential mechanism is not ready; no credential data is exposed.",
  }));
  if (listed.some((item) => item.id === "openrouter-coding-agent")) return listed;
  const readiness = openRouterReadiness();
  return [...listed, { id: "openrouter-coding-agent", provider: "openrouter", status: readiness.ready ? "ready" : "unavailable", supports: ["implementation", "repair"], providerCalls: true, runtime: ["local-disposable"], providerRequirements: ["OpenRouter credential"], networkRequirements: ["network authority", "external network allowed"], model: null, credentialReady: readiness.credentialReady, credentialReason: readiness.ready ? "OpenRouter credential mechanism is ready." : "OpenRouter credential mechanism is not ready; no credential data is exposed.", limitations: readiness.ready ? [] : ["OpenRouter credential mechanism is not ready."] }];
}

export function publicProviderRouting(executors: Executor[]): Record<string, unknown> {
  const openrouter = openRouterReadiness();
  return { providers: { local: { configured: true, credentialReady: executors.some((item) => providerForExecutor(item) === "local" && item.status === "ready") }, openrouter: { ...openrouter, executorId: "openrouter-coding-agent", reason: openrouter.ready ? "OpenRouter coding agent is ready." : "OpenRouter coding agent or its credential mechanism is not ready; no credential data is exposed." } }, phases: ["planner", "implementer", "repair", "reviewer"], fallbackPolicies: ["none", "same_provider"], noLocalFallbackForOpenRouter: true, budgets: { maxCalls: [1, 32], tokenBudget: "TaskSpec providerRouting.tokenBudget", costBudgetUsd: "optional TaskSpec providerRouting.costBudgetUsd", timeoutMs: "TaskSpec providerRouting.timeoutMs", maxAttempts: [1, 3] } };
}
