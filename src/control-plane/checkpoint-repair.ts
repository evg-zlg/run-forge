import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDurableCheckpoint } from "../implementation/durable-checkpoint.js";
import { ControlPlaneError, type ControlTaskRecord } from "./contracts.js";
import type { ControlPlaneStore } from "./state.js";

export type CheckpointRepairRequest = {
  taskId: string; decisionId: string; checkpointId: string; checkpointDigest: string;
  choice: "grant_additional_budget" | "retry_from_checkpoint";
  additionalProviderTokens: number; repairIntent: string | null;
};

export async function startCheckpointRepair(input: {
  task: ControlTaskRecord; request: CheckpointRepairRequest; store: ControlPlaneStore;
  acceptedSourceIsCurrent: () => Promise<boolean>;
  beginAttempt: (sourceExecutionId: string) => Promise<void>;
  persist: (type: string, detail?: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { task, request, store } = input;
  if (request.taskId !== task.id) throw error(task, "wrong_task_checkpoint", "Request taskId does not match the task endpoint.");
  const duplicate = task.decisions.find((item) => item.kind === "checkpoint_repair" && item.decisionId === request.decisionId);
  if (duplicate) {
    if (duplicate.response.checkpointId !== request.checkpointId || duplicate.response.checkpointDigest !== request.checkpointDigest || duplicate.decision !== request.choice) throw error(task, "idempotency_conflict", "The decision ID is already bound to a different checkpoint repair.");
    return { idempotentReplay: true, ...duplicate.response, repairExecutionId: task.checkpointRepair?.repairExecutionId ?? duplicate.response.repairExecutionId };
  }
  if (task.status !== "awaiting_owner_decision" || !task.ownerGate.required) throw error(task, "checkpoint_repair_gate_not_open", "Checkpoint repair requires the task's open owner gate.");
  if (!task.authority.implementation || task.authority.providerCalls !== true || task.authority.network !== true) throw new ControlPlaneError(403, "authority_denied", "Checkpoint repair cannot expand authority; existing implementation, providerCalls, and network authority are required.", undefined, false, task.id);
  const sourceExecutionId = task.progress.executionId;
  if (!sourceExecutionId) throw error(task, "execution_identity_missing", "Checkpoint repair requires a source execution identity.");
  const result = await store.readResult(task);
  const published = Array.isArray(object(result?.artifact).checkpoints) ? object(result?.artifact).checkpoints.find((item: any) => item?.id === request.checkpointId) : null;
  if (!published) throw error(task, "checkpoint_not_published", "Checkpoint is not part of the current normalized task result.");
  let checkpoint;
  try { checkpoint = await readDurableCheckpoint(task.artifactRoot, request.checkpointId); }
  catch (cause) { throw new ControlPlaneError(409, "checkpoint_digest_invalid", "Checkpoint payload or manifest integrity verification failed.", { reason: safeMessage(cause) }, false, task.id); }
  if (!checkpoint) throw new ControlPlaneError(404, "checkpoint_not_found", `Durable checkpoint not found: ${request.checkpointId}`, undefined, false, task.id);
  if (checkpoint.digest !== request.checkpointDigest || published.digest !== request.checkpointDigest) throw error(task, "checkpoint_digest_invalid", "Checkpoint digest does not match the published immutable checkpoint.");
  const spec = await store.readSpec(task.id); const expectedSha = typeof object(spec?.target).expectedSha === "string" ? object(spec?.target).expectedSha : null; const agreementId = task.executionAgreement?.agreementId;
  if (checkpoint.manifest.taskId !== task.id) throw error(task, "wrong_task_checkpoint", "Checkpoint task binding does not match this task.");
  if (!expectedSha || checkpoint.manifest.baseSha !== expectedSha) throw error(task, "stale_checkpoint", "Checkpoint base SHA does not match the accepted task source.");
  if (!agreementId || checkpoint.manifest.executionAgreementId !== agreementId) throw error(task, "checkpoint_agreement_mismatch", "Checkpoint Execution Agreement binding does not match the task.");
  if (object(spec?.execution).maxRepairIterations < 1) throw error(task, "repair_iterations_exhausted", "The accepted TaskSpec does not authorize a repair iteration.");
  const safety = object(JSON.parse(await readFile(join(checkpoint.path, "safety.json"), "utf8")));
  if (safety.targetMainMutation !== false || safety.targetMainPush !== false || safety.forbiddenZonesRespected !== true || safety.secretScanPassed !== true) throw error(task, "unsafe_checkpoint", "Checkpoint safety assertions do not permit provider repair.");
  if (!(await input.acceptedSourceIsCurrent())) throw error(task, "target_sha_changed", "Checkpoint repair is stale because the accepted source SHA is no longer current.");
  task.checkpointRepair = { schemaVersion: 1, decisionId: request.decisionId, checkpointId: request.checkpointId, checkpointDigest: request.checkpointDigest, checkpointArtifactRoot: task.artifactRoot, baseSha: expectedSha, executionAgreementId: agreementId, choice: request.choice, additionalProviderTokens: request.additionalProviderTokens, repairIntent: request.repairIntent, sourceExecutionId, repairExecutionId: null };
  const response: Record<string, unknown> = { schemaVersion: 1, taskId: task.id, decisionId: request.decisionId, checkpointId: request.checkpointId, checkpointDigest: request.checkpointDigest, choice: request.choice, status: "repair_generation_started", authorityGranted: false, authorityPreserved: task.authority, executionAgreementId: agreementId, baseSha: expectedSha, additionalProviderTokens: request.additionalProviderTokens, repairIntent: request.repairIntent, providerRun: true, targetMainMutation: false, patchFallback: checkpoint.patchPath, sourceExecutionId, repairExecutionId: null };
  task.decisions.push({ decisionId: request.decisionId, kind: "checkpoint_repair", decision: request.choice, createdAt: new Date().toISOString(), response });
  await input.beginAttempt(sourceExecutionId);
  task.checkpointRepair.repairExecutionId = task.progress.executionId; response.repairExecutionId = task.progress.executionId; task.decisions.at(-1)!.response = response;
  await input.persist("checkpoint_repair_started", task.progress.executionId ?? undefined);
  return response;
}

function error(task: ControlTaskRecord, code: string, message: string): ControlPlaneError { return new ControlPlaneError(409, code, message, undefined, false, task.id); }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function safeMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 500); }
