export function boundedProviderText(value: string, maxBytes = 16_384): string {
  const redacted = value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return Buffer.byteLength(redacted) <= maxBytes ? redacted : `${Buffer.from(redacted).subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`;
}
export function aggregateProviderAccounting(calls: Array<Record<string, unknown>>): { tokens: number; costUsd: number | null; usageAvailability: "complete" | "partial" | "unavailable"; costAvailability: "complete" | "partial" | "unavailable" } {
  const tokenValues = calls.map((call) => call.tokenUsage).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const costValues = calls.map((call) => call.costUsd).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const availability = (count: number): "complete" | "partial" | "unavailable" => count === calls.length ? "complete" : count ? "partial" : "unavailable";
  return { tokens: tokenValues.reduce((sum, value) => sum + value, 0), costUsd: costValues.length ? costValues.reduce((sum, value) => sum + value, 0) : null, usageAvailability: availability(tokenValues.length), costAvailability: availability(costValues.length) };
}
/**
 * Checks the cumulative reported provider usage for one execution phase.
 * A repair generation may contain more than one repair call, so comparing only
 * the last call would incorrectly leave a phase budget overrun unreported.
 */
export function phaseTokenOverrun(calls: Array<Record<string, unknown>>, phase: string, limit: number | undefined): { actual: number; limit: number } | null {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return null;
  const actual = calls
    .filter((call) => call.phase === phase)
    .reduce((sum, call) => sum + (typeof call.tokenUsage === "number" && Number.isFinite(call.tokenUsage) ? call.tokenUsage : 0), 0);
  return actual > limit ? { actual, limit } : null;
}
export function routingBudgetOverrun(calls: Array<Record<string, unknown>>, routing: { tokenBudget: { total: number; perPhase: Record<string, number> }; costBudgetUsd?: number }, phase: string): { kind: "phase_tokens" | "total_tokens" | "cost" | "accounting_unavailable"; actual: number; limit: number; reason: string } | null {
  const accounting = aggregateProviderAccounting(calls), phaseTokens = calls.filter((call) => call.phase === phase).reduce((sum, call) => sum + (typeof call.tokenUsage === "number" ? call.tokenUsage : 0), 0), phaseLimit = routing.tokenBudget.perPhase[phase];
  if (accounting.usageAvailability !== "complete") return { kind: "accounting_unavailable", actual: accounting.tokens, limit: routing.tokenBudget.total, reason: "OpenRouter token accounting is incomplete; budget enforcement stopped closed after durable evidence." };
  if (routing.costBudgetUsd !== undefined && accounting.costAvailability !== "complete") return { kind: "accounting_unavailable", actual: accounting.costUsd ?? 0, limit: routing.costBudgetUsd, reason: "OpenRouter cost accounting is incomplete; cost-budget enforcement stopped closed after durable evidence." };
  if (typeof phaseLimit === "number" && phaseTokens > phaseLimit) return { kind: "phase_tokens", actual: phaseTokens, limit: phaseLimit, reason: `OpenRouter ${phase} token budget exceeded after durable evidence: ${phaseTokens} > ${phaseLimit}.` };
  if (accounting.tokens > routing.tokenBudget.total) return { kind: "total_tokens", actual: accounting.tokens, limit: routing.tokenBudget.total, reason: `OpenRouter total token budget exceeded after durable evidence: ${accounting.tokens} > ${routing.tokenBudget.total}.` };
  if (routing.costBudgetUsd !== undefined && accounting.costUsd !== null && accounting.costUsd > routing.costBudgetUsd) return { kind: "cost", actual: accounting.costUsd, limit: routing.costBudgetUsd, reason: `OpenRouter cost budget exceeded after durable evidence: $${accounting.costUsd.toFixed(6)} > $${routing.costBudgetUsd.toFixed(6)}.` };
  return null;
}
