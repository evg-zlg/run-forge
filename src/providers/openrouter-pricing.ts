/** Server-owned price quotes. Clients cannot supply or override these bounds. */
export type OpenRouterModelPricing = { inputUsdPerToken: number; outputUsdPerToken: number };

export type OpenRouterPricingCatalogStatus = {
  configured: boolean;
  catalogValid: boolean;
  code: "not_configured" | "invalid" | "empty" | "ready";
  message: string;
};

export function openRouterPricingCatalogStatus(): OpenRouterPricingCatalogStatus {
  const raw = process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON;
  if (!raw?.trim()) return { configured: false, catalogValid: false, code: "not_configured", message: "Capped OpenRouter campaigns require RUNFORGE_OPENROUTER_MODEL_PRICING_JSON with a trusted quote for the selected planner model." };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.values(value as Record<string, unknown>).every(validQuote)) return { configured: true, catalogValid: false, code: "invalid", message: "RUNFORGE_OPENROUTER_MODEL_PRICING_JSON must be a JSON object whose model entries contain positive finite inputUsdPerToken and outputUsdPerToken values." };
    if (Object.keys(value).length === 0) return { configured: true, catalogValid: false, code: "empty", message: "RUNFORGE_OPENROUTER_MODEL_PRICING_JSON contains no trusted model quotes; capped campaigns require an exact quote for the selected planner model." };
    return { configured: true, catalogValid: true, code: "ready", message: "The trusted OpenRouter pricing catalog is valid; each capped campaign still requires an exact quote for its deterministically selected planner model." };
  } catch {
    return { configured: true, catalogValid: false, code: "invalid", message: "RUNFORGE_OPENROUTER_MODEL_PRICING_JSON is not valid JSON." };
  }
}

export function trustedOpenRouterModelPricing(model: string): OpenRouterModelPricing | null {
  // Provider aliases can change the billable model after admission; they are never a hard-cap quote.
  if (!model.trim() || /(^|\/)auto$/i.test(model.trim()) || /^auto$/i.test(model.trim())) return null;
  let value: unknown;
  try { value = JSON.parse(process.env.RUNFORGE_OPENROUTER_MODEL_PRICING_JSON ?? "{}"); } catch { return null; }
  const quote = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[model] : null;
  if (!validQuote(quote)) return null;
  return quote;
}

function validQuote(value: unknown): value is OpenRouterModelPricing {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, input = item.inputUsdPerToken, output = item.outputUsdPerToken;
  return typeof input === "number" && Number.isFinite(input) && input > 0 && typeof output === "number" && Number.isFinite(output) && output > 0;
}
