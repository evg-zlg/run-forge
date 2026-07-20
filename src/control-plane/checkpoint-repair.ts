import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readDurableCheckpoint, type DurableCheckpoint } from "../implementation/durable-checkpoint.js";
import { ControlPlaneError, type ControlTaskRecord, type ExecutionAttempt } from "./contracts.js";
import type { ControlPlaneStore } from "./state.js";

export type CheckpointRepairRequest = {
  taskId: string; decisionId: string; checkpointId: string; checkpointDigest: string;
  choice: "grant_additional_budget" | "retry_from_checkpoint";
  additionalProviderTokens: number; repairIntent: string | null;
};

type VerifiedRepairCheckpoint = {
  checkpoint: DurableCheckpoint;
  artifactRoot: string;
  expectedSha: string;
  agreementId: string;
  sourceExecutionId: string;
  schemaVersion: 1 | 2;
};

/** Adds verified schema-v1 digests to the public result without rewriting persisted artifacts or results. */
export async function exposeCheckpointRepairDigests(input: {
  task: ControlTaskRecord;
  result: Record<string, unknown>;
  store: ControlPlaneStore;
}): Promise<Record<string, unknown>> {
  const artifact = object(input.result.artifact);
  if (!Array.isArray(artifact.checkpoints)) return input.result;
  const checkpoints = await Promise.all(artifact.checkpoints.map(async (raw) => {
    const published = object(raw);
    if (typeof published.digest === "string") return raw;
    if (typeof published.id !== "string") return raw;
    try {
      const verified = await verifyRepairCheckpoint(input.task, published.id, input.store);
      if (verified.schemaVersion !== 1) return raw;
      return { ...published, digest: verified.checkpoint.digest, digestAlgorithm: "sha256", checkpointSchemaVersion: 1, digestSource: "verified_immutable_manifest" };
    } catch {
      return raw;
    }
  }));
  return {
    ...input.result,
    artifact: { ...artifact, checkpoints },
    checkpointRepairContract: {
      schemaVersion: 1,
      endpoint: `/v1/tasks/${input.task.id}/checkpoint-repairs`,
      digestField: "artifact.checkpoints[].digest",
      legacySchemaV1DigestsVerifiedOnRead: true,
      immutableArtifactsRewritten: false,
    },
  };
}

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
    const response = duplicate.response;
    const conflicts = response.taskId !== request.taskId || response.checkpointId !== request.checkpointId || response.checkpointDigest !== request.checkpointDigest || duplicate.decision !== request.choice || response.additionalProviderTokens !== request.additionalProviderTokens || response.repairIntent !== request.repairIntent;
    if (conflicts) throw error(task, "idempotency_conflict", "The decision ID is already bound to a different checkpoint repair.");
    const repairExecutionId = task.checkpointRepair?.repairExecutionId ?? task.execution.lastRetry?.executionId ?? response.repairExecutionId;
    return { idempotentReplay: true, ...response, repairExecutionId };
  }
  if (task.status !== "awaiting_owner_decision" || !task.ownerGate.required) throw error(task, "checkpoint_repair_gate_not_open", "Checkpoint repair requires the task's open owner gate.");
  if (!task.authority.implementation || task.authority.providerCalls !== true || task.authority.network !== true) throw new ControlPlaneError(403, "authority_denied", "Checkpoint repair cannot expand authority; existing implementation, providerCalls, and network authority are required.", undefined, false, task.id);
  const verified = await verifyRepairCheckpoint(task, request.checkpointId, store);
  if (verified.checkpoint.digest !== request.checkpointDigest) throw error(task, "checkpoint_digest_invalid", "Checkpoint digest does not match the published immutable checkpoint.");
  const spec = await store.readSpec(task.id);
  if (object(spec?.execution).maxRepairIterations < 1) throw error(task, "repair_iterations_exhausted", "The accepted TaskSpec does not authorize a repair iteration.");
  if (!(await input.acceptedSourceIsCurrent())) throw error(task, "target_sha_changed", "Checkpoint repair is stale because the accepted source SHA is no longer current.");
  task.checkpointRepair = { schemaVersion: 1, decisionId: request.decisionId, checkpointId: request.checkpointId, checkpointDigest: request.checkpointDigest, checkpointArtifactRoot: verified.artifactRoot, checkpointPatchPath: verified.checkpoint.patchPath, baseSha: verified.expectedSha, executionAgreementId: verified.agreementId, choice: request.choice, additionalProviderTokens: request.additionalProviderTokens, repairIntent: request.repairIntent, sourceExecutionId: verified.sourceExecutionId, repairExecutionId: null };
  const response: Record<string, unknown> = { schemaVersion: 1, taskId: task.id, decisionId: request.decisionId, checkpointId: request.checkpointId, checkpointDigest: request.checkpointDigest, checkpointSchemaVersion: verified.schemaVersion, choice: request.choice, status: "repair_generation_started", authorityGranted: false, authorityPreserved: task.authority, executionAgreementId: verified.agreementId, baseSha: verified.expectedSha, additionalProviderTokens: request.additionalProviderTokens, repairIntent: request.repairIntent, providerRun: true, targetMainMutation: false, patchFallback: verified.checkpoint.patchPath, sourceExecutionId: verified.sourceExecutionId, repairExecutionId: null };
  task.decisions.push({ decisionId: request.decisionId, kind: "checkpoint_repair", decision: request.choice, createdAt: new Date().toISOString(), response });
  await input.beginAttempt(verified.sourceExecutionId);
  task.checkpointRepair.repairExecutionId = task.progress.executionId; response.repairExecutionId = task.progress.executionId; task.decisions.at(-1)!.response = response;
  await input.persist("checkpoint_repair_started", task.progress.executionId ?? undefined);
  return response;
}

async function verifyRepairCheckpoint(task: ControlTaskRecord, checkpointId: string, store: ControlPlaneStore): Promise<VerifiedRepairCheckpoint> {
  const publishedEnvelope = await store.readPublishedResult(task.id);
  if (!publishedEnvelope || publishedEnvelope.executionId !== task.progress.executionId) throw error(task, "checkpoint_not_published", "Checkpoint is not part of the current persisted task result generation.");
  const result = object(publishedEnvelope.result);
  if (result.taskId !== task.id) throw error(task, "wrong_task_checkpoint", "Persisted result task binding does not match this task.");
  const published = Array.isArray(object(result.artifact).checkpoints) ? object(result.artifact).checkpoints.find((item: unknown) => object(item).id === checkpointId) : null;
  if (!published) throw error(task, "checkpoint_not_published", "Checkpoint is not part of the current normalized task result.");
  const attempt = task.execution.attempts.find((item) => item.executionId === publishedEnvelope.executionId);
  if (!attempt || attempt.operation !== "execution" || resolve(attempt.artifactRoot) !== resolve(task.artifactRoot)) throw error(task, "checkpoint_generation_mismatch", "Checkpoint artifact root is not bound to the current persisted execution generation.");
  assertPublishedMembership(task, result, published, attempt, checkpointId);
  let checkpoint: DurableCheckpoint;
  try {
    const read = await readDurableCheckpoint(attempt.artifactRoot, checkpointId);
    if (!read) throw new ControlPlaneError(404, "checkpoint_not_found", `Durable checkpoint not found: ${checkpointId}`, undefined, false, task.id);
    checkpoint = read;
  } catch (cause) {
    if (cause instanceof ControlPlaneError) throw cause;
    throw new ControlPlaneError(409, "checkpoint_digest_invalid", "Checkpoint payload or manifest integrity verification failed.", { reason: safeMessage(cause) }, false, task.id);
  }
  assertPublishedRecordBinding(task, published, attempt, checkpoint);
  const canonicalSpec = object(await store.readSpec(task.id));
  const attemptSpec = object(await readJson(attempt.specPath));
  const expectedSha = stringField(object(canonicalSpec.target).expectedSha);
  const attemptExpectedSha = stringField(object(attemptSpec.target).expectedSha);
  if (canonicalSpec.taskId !== task.id || attemptSpec.taskId !== task.id) throw error(task, "wrong_task_checkpoint", "Persisted TaskSpec binding does not match this task.");
  if (!expectedSha || attemptExpectedSha !== expectedSha || object(attemptSpec.artifacts).root !== attempt.artifactRoot || checkpoint.manifest.baseSha !== expectedSha) throw error(task, "stale_checkpoint", "Checkpoint base SHA does not match the accepted task source and execution spec.");
  const agreementId = task.executionAgreement?.agreementId;
  const persistedAgreement = agreementId ? await store.getAgreement(agreementId) : null;
  if (!agreementId || !persistedAgreement || task.executionAgreement?.conflicts.length || JSON.stringify(persistedAgreement) !== JSON.stringify(task.executionAgreement)) throw error(task, "checkpoint_agreement_mismatch", "Checkpoint repair requires the unchanged accepted persisted Execution Agreement.");
  const safety = object(await readJson(join(checkpoint.path, "safety.json")));
  if (safety.targetMainMutation !== false || safety.targetMainPush !== false || safety.forbiddenZonesRespected !== true || safety.secretScanPassed !== true) throw error(task, "unsafe_checkpoint", "Checkpoint safety assertions do not permit provider repair.");
  await assertChangedFilesSafe(task, checkpoint.path, canonicalSpec);
  if (checkpoint.manifest.schemaVersion === 2) {
    if (checkpoint.manifest.taskId !== task.id) throw error(task, "wrong_task_checkpoint", "Checkpoint task binding does not match this task.");
    if (checkpoint.manifest.executionAgreementId !== agreementId) throw error(task, "checkpoint_agreement_mismatch", "Checkpoint Execution Agreement binding does not match the task.");
    if (published.digest !== checkpoint.digest) throw error(task, "checkpoint_digest_invalid", "Checkpoint digest does not match the published immutable checkpoint.");
  } else {
    const executor = object(await readJson(join(checkpoint.path, "executor.json")));
    if (executor.generation !== attempt.executionId || executor.attempt !== attempt.attempt) throw error(task, "checkpoint_generation_mismatch", "Legacy checkpoint executor identity does not match the persisted execution generation.");
    if (published.digest !== undefined && published.digest !== checkpoint.digest) throw error(task, "checkpoint_digest_invalid", "Legacy checkpoint digest does not match the immutable manifest.");
  }
  return { checkpoint, artifactRoot: attempt.artifactRoot, expectedSha, agreementId, sourceExecutionId: attempt.executionId, schemaVersion: checkpoint.manifest.schemaVersion };
}

function assertPublishedMembership(task: ControlTaskRecord, result: Record<string, unknown>, published: Record<string, any>, attempt: ExecutionAttempt, checkpointId: string): void {
  const checkpointPath = `checkpoints/${checkpointId}`;
  if (typeof published.path !== "string" || typeof published.patchPath !== "string" || !Number.isSafeInteger(published.iteration) || published.iteration < 0) throw error(task, "checkpoint_not_published", "Published checkpoint membership contains unsafe or inconsistent paths.");
  if (!published.path.startsWith(`${checkpointPath}/`) && published.path !== checkpointPath) throw error(task, "checkpoint_not_published", "Published checkpoint path is outside the checkpoint namespace.");
  if (!published.patchPath.startsWith(`${checkpointPath}/`) || !published.patchPath.endsWith("/patch.diff")) throw error(task, "checkpoint_not_published", "Published checkpoint patch path is outside the checkpoint namespace.");
  if (resolve(attempt.artifactRoot, published.path) !== join(resolve(attempt.artifactRoot), published.path) || resolve(attempt.artifactRoot, published.patchPath) !== join(resolve(attempt.artifactRoot), published.patchPath)) throw error(task, "checkpoint_not_published", "Published checkpoint paths escape the persisted artifact root.");
  const artifactPaths = object(result.artifacts).checkpoints;
  if (!Array.isArray(artifactPaths) || !artifactPaths.includes(published.path)) throw error(task, "checkpoint_not_published", "Checkpoint is absent from the persisted artifact membership list.");
}

/** Binds public membership to the verified immutable v2 record (or the flat v1 record). */
function assertPublishedRecordBinding(task: ControlTaskRecord, published: Record<string, any>, attempt: ExecutionAttempt, checkpoint: DurableCheckpoint): void {
  const checkpointPath = relative(attempt.artifactRoot, checkpoint.path);
  const patchPath = relative(attempt.artifactRoot, checkpoint.patchPath);
  if (published.path !== checkpointPath || published.patchPath !== patchPath) throw error(task, "checkpoint_not_published", "Published checkpoint paths do not bind to the verified immutable record.");
}

async function assertChangedFilesSafe(task: ControlTaskRecord, checkpointPath: string, spec: Record<string, unknown>): Promise<void> {
  const changedFiles = await readJson(join(checkpointPath, "changed-files.json"));
  if (!Array.isArray(changedFiles) || changedFiles.some((item) => typeof item !== "string" || !item || item.startsWith("/") || item === ".." || item.startsWith("../") || item.includes("\\"))) throw error(task, "unsafe_checkpoint", "Checkpoint changed-file membership is unsafe.");
  const normalized = [...new Set(changedFiles)].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(changedFiles)) throw error(task, "unsafe_checkpoint", "Checkpoint changed-file membership is not canonical.");
  const execution = object(spec.execution);
  if (Number.isSafeInteger(execution.maxChangedFiles) && changedFiles.length > execution.maxChangedFiles) throw error(task, "unsafe_checkpoint", "Checkpoint exceeds the accepted changed-file limit.");
  const rawZones: unknown = object(spec.authority).forbiddenAreas;
  const zones: string[] = Array.isArray(rawZones) ? rawZones.filter((item: unknown): item is string => typeof item === "string") : [];
  const pathZones = zones.filter((zone) => !/\s/.test(zone)).map((zone) => zone.replace(/^\.\//, "").replace(/\*\*|\*/g, "").replace(/\/$/, ""));
  if (changedFiles.some((file) => pathZones.some((zone) => zone && (file === zone || file.startsWith(`${zone}/`))))) throw error(task, "unsafe_checkpoint", "Checkpoint includes a path forbidden by the accepted TaskSpec.");
}

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
function error(task: ControlTaskRecord, code: string, message: string): ControlPlaneError { return new ControlPlaneError(409, code, message, undefined, false, task.id); }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function stringField(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function safeMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 500); }
