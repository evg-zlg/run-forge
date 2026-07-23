import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { listDurableCheckpoints } from "../implementation/durable-checkpoint.js";
import type { ControlTaskRecord } from "./contracts.js";

export async function reconstructTerminalReceipt(
  task: ControlTaskRecord,
  store: { readResult: (task: ControlTaskRecord) => Promise<unknown>; readSpec: (id: string) => Promise<unknown> },
  knownCheckpoints?: Awaited<ReturnType<typeof listDurableCheckpoints>>
): Promise<Record<string, unknown>> {
  const persisted = object(await store.readResult(task));
  const previous = object(persisted.receipt);
  const checkpoints = knownCheckpoints ?? await listDurableCheckpoints(task.artifactRoot);
  const checkpoint = checkpoints.at(-1) ?? null;

  const checkpointChanged = checkpoint ? await readJsonArray(join(checkpoint.path, "changed-files.json")) : [];
  const checkpointValidation = checkpoint ? await readJsonArray(join(checkpoint.path, "validation.json")) : [];
  const checkpointUsage = checkpoint ? await readJsonObject(join(checkpoint.path, "usage.json")) : {};
  const checkpointExecutor = checkpoint ? await readJsonObject(join(checkpoint.path, "executor.json")) : {};

  const persistedValidation = Array.isArray(persisted.validation) ? persisted.validation : Array.isArray(persisted.validations) ? persisted.validations : [];
  const validation = checkpointValidation.length ? checkpointValidation : persistedValidation;

  const filesChanged = uniqueStrings(checkpointChanged.length ? checkpointChanged : previous.filesChanged);
  const filesRead = uniqueStrings(previous.filesRead ?? checkpointExecutor.filesRead);
  const patchAvailable = Boolean(checkpoint || previous.patchAvailable === true);
  const testsStarted = nonnegativeInteger(previous.testsStarted) ?? validation.length;
  const testsCompleted = nonnegativeInteger(previous.testsCompleted) ?? validation.filter((item) => validationCompleted(item)).length;

  const attempt = task.execution.attempts.find((item) => item.executionId === (task.progress.executionId ?? task.recovery?.originalExecutionId)) ?? task.execution.attempts.at(-1);
  const lastRetry = task.execution.lastRetry;

  let queuedAt = task.createdAt;
  if (lastRetry && lastRetry.executionId === attempt?.executionId) queuedAt = lastRetry.requestedAt;

  const startedAt = attempt?.startedAt ?? task.progress.startedAt ?? queuedAt;
  const finishedAt = attempt?.finishedAt ?? task.finishedAt ?? task.updatedAt;

  const queueDuration = duration(queuedAt, startedAt);
  const providerExecutionDuration = duration(startedAt, finishedAt);
  const totalDuration = duration(queuedAt, finishedAt);

  const reason = task.recovery?.cleanupStatus === "detached" ? "worker_cleanup_failed" : task.recovery?.reason ?? "worker_failed";
  const persistedStop = receiptOutcome(previous.stopReason);
  const stopReason = persistedStop ?? terminalStopReason(reason, task.progress.phase);

  const checkpointWithoutValidation = Boolean(checkpoint && testsStarted === 0);
  const outcome = checkpoint ? "checkpoint_available" : filesChanged.length || patchAvailable ? "validation_not_started" : "no_progress";
  const failureClassification = checkpointWithoutValidation ? "validation_not_started" : stopReason === "cancellation" ? null : stopReason;

  const metric = (name: string): number | null => nonnegativeNumber(previous[name] ?? checkpointUsage[name]);
  const availability = (name: string, value: number | null): string => metricAvailability(object(previous.availability)[name]) ?? (value === null ? "not_reported" : "reported");

  const inputTokens = metric("inputTokens");
  const cachedTokens = metric("cachedTokens");
  const outputTokens = metric("outputTokens");
  const reasoningTokens = metric("reasoningTokens");
  const billedTokens = metric("billedTokens");
  const cost = metric("cost");

  const calls = nonnegativeInteger(previous.calls ?? checkpointExecutor.calls ?? (Array.isArray(persisted.providerCalls) ? persisted.providerCalls.length : undefined)) ?? 0;

  const phase = checkpoint?.manifest.kind ?? (previous.phase === "repair" ? "repair" : "implementation");
  const lastCompletedStage = testsCompleted ? "validation" : checkpoint ? "checkpoint" : filesChanged.length || patchAvailable ? "implementation" : calls ? "provider" : "queued";

  const nextSafeAction = checkpoint
    ? "review_checkpoint"
    : stopReason === "deadline_exceeded"
    ? "retry_with_bounded_deadline"
    : stopReason === "cancellation"
    ? "preserve_cancellation"
    : stopReason === "infrastructure_failure"
    ? "repair_infrastructure_then_retry"
    : "inspect_diagnostics_then_retry";

  const selection = task.selection;

  return {
    queueDuration,
    providerExecutionDuration,
    totalDuration,
    provider: stringEvidence(previous.provider, checkpointExecutor.provider, selection?.provider, selection?.selectedExecutor, "control-plane"),
    model: nullableString(previous.model ?? checkpointExecutor.model ?? selection?.model),
    phase,
    calls,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    billedTokens,
    cost,
    availability: {
      queueDuration: "derived",
      inputTokens: availability("inputTokens", inputTokens),
      cachedTokens: availability("cachedTokens", cachedTokens),
      outputTokens: availability("outputTokens", outputTokens),
      reasoningTokens: availability("reasoningTokens", reasoningTokens),
      billedTokens: availability("billedTokens", billedTokens),
      cost: availability("cost", cost),
    },
    filesRead,
    filesChanged,
    patchAvailable,
    checkpointId: checkpoint?.id ?? nullableString(previous.checkpointId),
    testsStarted,
    testsCompleted,
    outcome,
    stopReason,
    failureClassification,
    lastCompletedStage,
    nextSafeAction,
  };
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function duration(from: string | null | undefined, to: string | null | undefined): number {
  const start = from ? Date.parse(from) : NaN;
  const end = to ? Date.parse(to) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round(end - start)) : 0;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringEvidence(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? "control-plane";
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))].sort() : [];
}

function metricAvailability(value: unknown): "reported" | "partially_reported" | "not_reported" | "derived" | null {
  return ["reported", "partially_reported", "not_reported", "derived"].includes(String(value))
    ? (value as "reported" | "partially_reported" | "not_reported" | "derived")
    : null;
}

function receiptOutcome(value: unknown): string | null {
  return ["completed", "no_progress", "budget_exhausted", "deadline_exceeded", "provider_failed", "implementation_failed", "checkpoint_available", "validation_not_started", "cancellation", "infrastructure_failure"].includes(
    String(value)
  )
    ? String(value)
    : null;
}

function terminalStopReason(reason: string, phase: string): string {
  if (reason === "execution_deadline_exceeded") return "deadline_exceeded";
  if (reason === "cancelled_by_operator") return "cancellation";
  if (reason.includes("provider") || phase.toLowerCase().includes("provider")) return "provider_failed";
  return "infrastructure_failure";
}

function validationCompleted(value: unknown): boolean {
  const status = String(object(value).status ?? object(value).result ?? "").toLowerCase();
  return Boolean(status) && !["running", "started", "pending", "not_started", "not_run", "skipped"].includes(status);
}

async function readJsonArray(path: string): Promise<unknown[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
}
