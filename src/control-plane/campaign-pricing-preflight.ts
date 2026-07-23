import type { CampaignSpec } from "./contracts.js";
import { ControlPlaneError } from "./contracts.js";
import { openRouterPricingCatalogStatus, trustedOpenRouterModelPricing } from "../providers/openrouter-pricing.js";
import { selectCampaignPlannerModel } from "../run/semantic-campaign-planner.js";

export function assertCappedCampaignPricingReady(id: string, spec: CampaignSpec): void {
  if (spec.providerRouting.provider !== "openrouter" || spec.limits.maxCostUsd === undefined) return;
  const catalog = openRouterPricingCatalogStatus();
  const model = selectCampaignPlannerModel(spec, id);
  if (!catalog.configured) throw new ControlPlaneError(422, "openrouter_pricing_catalog_unavailable", catalog.message, { catalog: { configured: false, catalogValid: false }, selectedPlannerModel: model, selectedModelPricingReady: false });
  if (!catalog.catalogValid) throw new ControlPlaneError(422, "openrouter_pricing_catalog_invalid", catalog.message, { catalog: { configured: true, catalogValid: false }, selectedPlannerModel: model, selectedModelPricingReady: false });
  if (!trustedOpenRouterModelPricing(model)) throw new ControlPlaneError(422, "openrouter_model_pricing_unavailable", `The capped campaign's deterministically selected planner model '${model}' has no trusted exact quote. Add that exact model to RUNFORGE_OPENROUTER_MODEL_PRICING_JSON; dynamic aliases such as 'auto' are not accepted.`, { catalog: { configured: true, catalogValid: true }, selectedPlannerModel: model, selectedModelPricingReady: false });
}
