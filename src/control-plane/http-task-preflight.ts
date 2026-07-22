import type { ExecutionAgreement } from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor } from "../product/task-spec-contract.js";
import { selectProviderModel } from "../product/provider-routing.js";

/** Stable HTTP-facing preflight facts.  This deliberately performs no provider call. */
export type HttpTaskPreflight = {
  schemaVersion: 1;
  outcome: "preflight_contract_rejected" | "semantic_review_negotiated";
  runtime: string;
  reviewer: { required: boolean; provider: "openrouter" | "local" | null; model: string | null };
};

export function requestedRuntimeCorrection(taskSpec: Record<string, unknown>): Record<string, unknown> {
  const corrected = structuredClone(taskSpec);
  const runtime = object(corrected.runtime);
  corrected.runtime = { ...runtime, preference: implementationExecutorContract.defaultRuntime };
  return corrected;
}

export function runtimeContractFailure(spec: TaskSpecV2): string | null {
  if (!["implementation", "repair"].includes(spec.execution.mode)) return null;
  return runtimeCompatibleWithImplementationExecutor(spec.runtime.preference) ? null : `runtime '${spec.runtime.preference}' is incompatible with the implementation executor`;
}

/**
 * A semantic review is never inferred from discovery or structural validation.
 * This only reserves a compatible reviewer route; completion is reported from
 * the provider-backed execution result.
 */
export function negotiateSemanticReviewer(spec: TaskSpecV2, agreement: ExecutionAgreement): HttpTaskPreflight {
  const required = agreement.phases.find((phase) => phase.phaseId === "independentReview")?.responsibleParty === "runforge";
  if (!required) return { schemaVersion: 1, outcome: "semantic_review_negotiated", runtime: spec.runtime.preference, reviewer: { required: false, provider: null, model: null } };
  const provider = spec.providerRouting.provider;
  const model = provider === "openrouter" ? selectProviderModel(spec.providerRouting, "reviewer", spec.taskId)?.model ?? null : null;
  return { schemaVersion: 1, outcome: "semantic_review_negotiated", runtime: spec.runtime.preference, reviewer: { required: true, provider, model } };
}

export function reviewerUnavailableReason(preflight: HttpTaskPreflight): string | null {
  if (!preflight.reviewer.required) return null;
  if (preflight.reviewer.provider === "openrouter" && !preflight.reviewer.model) return "OpenRouter semantic review requires a configured reviewer model.";
  return null;
}

/** Typed execution boundary: only a stage explicitly recorded before a provider call is retryable in-place. */
export class PreProviderSetupFailure extends Error {
  readonly outcome = "runtime_capability_mismatch" as const;
  readonly providerCalls = 0 as const;
  constructor(readonly stage: "workspace_setup" | "runtime_setup" | "dependency_setup", message: string) { super(message); this.name = "PreProviderSetupFailure"; }
}
export function classifyPreProviderFailure(error: unknown): { outcome: "runtime_capability_mismatch"; actions: ["retry", "retry_with_corrected_runtime"] } | null {
  return error instanceof PreProviderSetupFailure && error.providerCalls === 0 ? { outcome: error.outcome, actions: ["retry", "retry_with_corrected_runtime"] } : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
