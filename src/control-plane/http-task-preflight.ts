import type { ExecutionAgreement } from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import {
  implementationExecutorContract,
  runtimeCompatibleWithImplementationExecutor,
} from "../product/task-spec-contract.js";
import { selectOpenRouterSemanticReviewer } from "../implementation/openrouter-executor.js";
import { discoverFactoryVpsCapability } from "../implementation/factory-vps-contract.js";
import { ControlPlaneError } from "./contracts.js";

/** Stable HTTP-facing preflight facts.  This deliberately performs no provider call. */
export type HttpTaskPreflight = {
  schemaVersion: 1;
  outcome: "preflight_contract_rejected" | "semantic_review_negotiated";
  runtime: string;
  reviewer: {
    required: boolean;
    provider: "openrouter" | "local" | null;
    model: string | null;
  };
};

export function requestedRuntimeCorrection(
  taskSpec: Record<string, unknown>,
): Record<string, unknown> {
  const corrected = structuredClone(taskSpec);
  const runtime = object(corrected.runtime);
  corrected.runtime = {
    ...runtime,
    preference: implementationExecutorContract.defaultRuntime,
  };
  return corrected;
}

export function requestedSemanticValidationRuntimeCorrection(
  taskSpec: Record<string, unknown>,
): Record<string, unknown> {
  const corrected = structuredClone(taskSpec);
  corrected.runtime = { ...object(corrected.runtime), preference: "docker" };
  return corrected;
}

export function runtimeContractFailure(spec: TaskSpecV2): string | null {
  if (!["implementation", "repair"].includes(spec.execution.mode)) return null;
  return runtimeCompatibleWithImplementationExecutor(spec.runtime.preference)
    ? null
    : `runtime '${spec.runtime.preference}' is incompatible with the implementation executor`;
}

/**
 * A semantic review is never inferred from discovery or structural validation.
 * This only reserves a compatible reviewer route; completion is reported from
 * the provider-backed execution result.
 */
export function negotiateSemanticReviewer(
  spec: TaskSpecV2,
  agreement: ExecutionAgreement,
): HttpTaskPreflight {
  const selection = selectOpenRouterSemanticReviewer(spec, agreement);
  const required = selection.reason !== "semantic_review_not_requested";
  if (!required)
    return {
      schemaVersion: 1,
      outcome: "semantic_review_negotiated",
      runtime: spec.runtime.preference,
      reviewer: { required: false, provider: null, model: null },
    };
  return {
    schemaVersion: 1,
    outcome: selection.selected
      ? "semantic_review_negotiated"
      : "preflight_contract_rejected",
    runtime: spec.runtime.preference,
    reviewer: {
      required: true,
      provider: "openrouter",
      model: selection.selected?.model ?? null,
    },
  };
}

export function reviewerUnavailableReason(
  preflight: HttpTaskPreflight,
): string | null {
  if (!preflight.reviewer.required) return null;
  if (preflight.outcome === "preflight_contract_rejected")
    return "OpenRouter semantic review requires provider/network authority, external network access, ready credentials/backend, and a configured reviewer model.";
  if (preflight.reviewer.provider === "openrouter" && !preflight.reviewer.model)
    return "OpenRouter semantic review requires a configured reviewer model.";
  return null;
}

/** Remote routing fails closed until a versioned VPS bridge is dispatch-capable. */
export async function assertFactoryVpsExecutor(
  spec: TaskSpecV2,
  taskId: string,
): Promise<void> {
  if (spec.execution.executor !== "runforge-factory-vps") return;
  const remote = await discoverFactoryVpsCapability();
  if (remote.health === "ready") return;
  throw new ControlPlaneError(
    503,
    "factory_vps_unavailable",
    "The Factory VPS bridge is not ready; no provider call or local fallback was attempted.",
    {
      executorId: "runforge-factory-vps",
      health: remote.health,
      protocolVersion: remote.protocolVersion,
      reason: "reason" in remote ? remote.reason : null,
      noLocalFallback: true,
      operation: "start_new_task",
      newTaskRequired: true,
    },
    true,
    taskId,
  );
}

/** Typed execution boundary: only a stage explicitly recorded before a provider call is retryable in-place. */
export class PreProviderSetupFailure extends Error {
  readonly outcome = "runtime_capability_mismatch" as const;
  readonly providerCalls = 0 as const;
  constructor(
    readonly stage: "workspace_setup" | "runtime_setup" | "dependency_setup",
    message: string,
  ) {
    super(message);
    this.name = "PreProviderSetupFailure";
  }
}
export function classifyPreProviderFailure(
  error: unknown,
): {
  outcome: "runtime_capability_mismatch";
  actions: ["retry", "retry_with_corrected_runtime"];
} | null {
  return error instanceof PreProviderSetupFailure && error.providerCalls === 0
    ? {
        outcome: error.outcome,
        actions: ["retry", "retry_with_corrected_runtime"],
      }
    : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
