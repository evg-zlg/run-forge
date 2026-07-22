import { join } from "node:path";
import { normalizeTaskSpecV2 } from "../product/task-spec-v2.js";
import { validationSemanticReviewOptIn } from "../product/execution-agreement.js";
import { ControlPlaneError, type ControlTaskRecord } from "./contracts.js";
import type { ControlPlaneStore } from "./state.js";
import { acceptValidationCapabilities, type ValidationCapabilityNegotiation } from "./validation-negotiation.js";

export async function negotiateCorrectedRetryValidation(input: { store: ControlPlaneStore; task: ControlTaskRecord; runtimePreference: "local-disposable" }): Promise<ValidationCapabilityNegotiation> {
  const { store, task, runtimePreference } = input;
  const canonical = await store.readSpec(task.id);
  if (!canonical || !task.executionAgreement) throw new ControlPlaneError(409, "retry_contract_unavailable", "The canonical TaskSpec or Execution Agreement is unavailable for retry negotiation.", undefined, false, task.id);
  if (validationSemanticReviewOptIn(task.executionAgreement)) throw new ControlPlaneError(422, "semantic_validation_runtime_mismatch", "Provider-backed semantic validation is Docker-only; retry with the accepted Docker runtime.", { correctedRuntime: "docker", operation: `/v1/tasks/${task.id}/retry`, newTaskRequired: false }, false, task.id);
  const attempt = structuredClone(canonical);
  attempt.runtime = { ...object(attempt.runtime), preference: runtimePreference };
  attempt.artifacts = { ...object(attempt.artifacts), root: join(store.taskDir(task.id), "attempts", String(task.execution.attempt + 1), "artifacts"), resultFormat: "normalized-v1" };
  let normalized: Awaited<ReturnType<typeof normalizeTaskSpecV2>>;
  try { normalized = await normalizeTaskSpecV2(attempt); }
  catch (error) { throw new ControlPlaneError(422, "invalid_retry_runtime", error instanceof Error ? error.message : String(error), { operation: `/v1/tasks/${task.id}/retry`, newTaskRequired: false }, false, task.id); }
  return acceptValidationCapabilities(normalized, task.executionAgreement, task.id);
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
