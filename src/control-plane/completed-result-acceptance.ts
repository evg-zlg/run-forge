import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishDurableCheckpointTransition, readDurableCheckpoint } from "../implementation/durable-checkpoint.js";
import { ControlPlaneError, type ControlTaskRecord } from "./contracts.js";
import type { ControlPlaneStore } from "./state.js";
import { validationSatisfiesImplementationCheckpoint, type ValidationOutcomeRecord } from "../validation/capability-contract.js";

export type AcceptCompletedInput = { decisionId: string; checkpointId: string; delivery: "patch" | "local_commit" };

export async function acceptCompletedResult(input: { task: ControlTaskRecord; request: AcceptCompletedInput; store: ControlPlaneStore; persist: (type: string, detail: string) => Promise<void> }): Promise<Record<string, unknown>> {
  const { task, request, store } = input;
  const duplicate = task.decisions.find((item) => item.kind === "accept_completed" && item.decisionId === request.decisionId);
  if (duplicate) {
    if (duplicate.response.checkpointId !== request.checkpointId || duplicate.response.delivery !== request.delivery) throw new ControlPlaneError(409, "idempotency_conflict", "The decision ID was already bound to a different completed result.", undefined, false, task.id);
    return { idempotentReplay: true, ...duplicate.response };
  }
  const checkpoint = await readDurableCheckpoint(task.artifactRoot, request.checkpointId);
  if (!checkpoint) throw new ControlPlaneError(404, "checkpoint_not_found", `Durable checkpoint not found: ${request.checkpointId}`, undefined, false, task.id);
  const result = await store.readResult(task); const artifact = object(result?.artifact); const publishedCheckpoint = Array.isArray(artifact.checkpoints) ? artifact.checkpoints.find((item: any) => item?.id === request.checkpointId) : null; const known = Boolean(publishedCheckpoint);
  if (!known) throw new ControlPlaneError(409, "checkpoint_not_published", "Checkpoint is not part of the task normalized result.", undefined, false, task.id);
  const candidateEvidence = checkpoint.manifest.schemaVersion === 2 && checkpoint.manifest.status === "validated" ? await validatedCandidateEvidence(task.artifactRoot, request.checkpointId, checkpoint.manifest.previousDigest) : null;
  if (publishedCheckpoint?.validationPassed !== true && !candidateEvidence) throw new ControlPlaneError(409, "checkpoint_not_validated", "Only a checkpoint validated by the original run or a compatible candidate binary can be accepted; unvalidated checkpoints remain rejected.", undefined, false, task.id);
  if (request.delivery === "local_commit" && !object(result?.git).commit) throw new ControlPlaneError(409, "local_commit_unavailable", "The accepted checkpoint has no RunForge-owned local commit; request patch delivery.", undefined, false, task.id);
  const response = { schemaVersion: 1, decisionId: request.decisionId, checkpointId: request.checkpointId, delivery: request.delivery, status: "accepted", artifact: request.delivery === "patch" ? `checkpoints/${request.checkpointId}/patch.diff` : object(result?.git).commit, ...(request.delivery === "patch" ? { patch: await readFile(checkpoint.patchPath, "utf8") } : {}), providerCalls: 0, providerRerun: false, targetMainMutation: false, authorityGranted: false, ...(candidateEvidence ? { candidateValidation: { binarySha256: object(candidateEvidence.candidateBinary).sha256, evidence: candidateEvidence.path } } : {}), budgetOverrunPreserved: object(result?.usage), handoff: object(result?.handoffPackage), acceptedAt: new Date().toISOString() };
  task.decisions.push({ decisionId: request.decisionId, kind: "accept_completed", decision: "accept_completed_patch", createdAt: response.acceptedAt, response }); task.ownerGate = { required: false, status: "completed_result_accepted", reason: "Existing checkpoint accepted without provider rerun or new authority." }; task.updatedAt = response.acceptedAt;
  const auditPath = join(task.artifactRoot, "accepted-completed-result.json"), temporary = `${auditPath}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(response, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); await rename(temporary, auditPath);
  if (checkpoint.manifest.schemaVersion === 2 && checkpoint.manifest.status === "validated") await publishDurableCheckpointTransition(task.artifactRoot, request.checkpointId, { status: "accepted", expectedPreviousDigest: checkpoint.digest, reason: `decision ${request.decisionId}` });
  await input.persist("completed_result_accepted", request.checkpointId); return response;
}

async function validatedCandidateEvidence(root: string, checkpointId: string, expectedDigest: string | null): Promise<Record<string, any> | null> {
  const directory = join(root, "checkpoint-resume", checkpointId); const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter((item) => item.endsWith(".candidate-validation-evidence.json")).sort().reverse()) try { const content = await readFile(join(directory, name), "utf8"), declaredDigest = name.slice(0, 64); if (!/^[a-f0-9]{64}$/.test(declaredDigest) || createHash("sha256").update(content).digest("hex") !== declaredDigest) continue; const value = JSON.parse(content) as Record<string, any>, validations = Array.isArray(value.validations) ? value.validations as ValidationOutcomeRecord[] : []; if (value.checkpointDigest === expectedDigest && value.providerCalls === 0 && object(value.candidateBinary).compatible === true && /^[a-f0-9]{64}$/.test(String(object(value.candidateBinary).sha256)) && validationSatisfiesImplementationCheckpoint(validations)) return { ...value, path: `checkpoint-resume/${checkpointId}/${name}` }; } catch { /* Ignore malformed non-authoritative evidence. */ }
  return null;
}

export async function discardCompletedResult(input: { task: ControlTaskRecord; request: { decisionId: string; checkpointId: string; confirmation: "discard_result" }; store: ControlPlaneStore; persist: (type: string, detail: string) => Promise<void> }): Promise<Record<string, unknown>> {
  const { task, request } = input; const duplicate = task.decisions.find((item) => item.kind === "discard_result" && item.decisionId === request.decisionId);
  if (duplicate) {
    if (duplicate.response.checkpointId !== request.checkpointId) throw new ControlPlaneError(409, "idempotency_conflict", "The decision ID was already bound to a different completed result.", undefined, false, task.id);
    return { idempotentReplay: true, ...duplicate.response };
  }
  const checkpoint = await readDurableCheckpoint(task.artifactRoot, request.checkpointId); if (!checkpoint) throw new ControlPlaneError(404, "checkpoint_not_found", `Durable checkpoint not found: ${request.checkpointId}`, undefined, false, task.id);
  const response = { schemaVersion: 1, decisionId: request.decisionId, checkpointId: request.checkpointId, status: "discarded_by_explicit_owner_decision", artifactsDeleted: false, providerCalls: 0, targetMainMutation: false, discardedAt: new Date().toISOString() };
  task.decisions.push({ decisionId: request.decisionId, kind: "discard_result", decision: "discard_result", createdAt: response.discardedAt, response }); task.ownerGate = { required: false, status: "result_discarded", reason: "Owner explicitly discarded delivery; immutable audit artifacts were retained." }; task.updatedAt = response.discardedAt; await input.persist("completed_result_discarded", request.checkpointId); return response;
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
