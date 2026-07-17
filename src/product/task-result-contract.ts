import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalExecutionResult } from "../run/external-execution.js";
import type { TaskRunResult } from "../run/task-run-harness.js";
import type { ExecutorResult } from "../run/task-run-executor.js";

export function completionStatusForIntent(input: { executionStatus: string; implementationExpected: boolean; targetChanged: boolean; patch?: string | null; commit?: string | null; pullRequest?: string | null }): string {
  if (input.executionStatus !== "completed" || !input.implementationExpected) return input.executionStatus;
  return input.targetChanged || input.patch || input.commit || input.pullRequest ? "completed" : "implementation_not_started";
}

export function taskRunResultContract(result: TaskRunResult, taskId: string): Record<string, unknown> {
  const initialSha = result.sourceRepository.before?.head ?? null;
  return {
    schemaVersion: 1, contract: "runforge-task-result", taskId,
    targetRepository: { path: result.sourceRepository.before?.path ?? null, initialSha, finalSha: result.sourceRepository.after?.head ?? initialSha, changed: result.sourceRepository.external ? result.sourceRepository.unchanged === false : false },
    completedWork: result.subtasks.map((item) => ({ id: item.id, goal: item.goal, status: item.executor.status, findings: item.findings })),
    validation: [
      ...result.subtasks.map((item) => ({ command: item.evidence.command, status: item.evidence.status, exitCode: item.evidence.exitCode, kind: "task-validation" })),
      ...result.checks.map((check) => ({ command: check.command, status: check.result, exitCode: check.exitCode, kind: "safety-check" }))
    ],
    git: { branch: null, commit: null, pullRequest: null, merge: null },
    ownerGate: { required: result.review.resultPayload.humanDecisionRequired, status: result.review.resultPayload.humanDecisionRequired ? "awaiting_owner_decision" : "not_required" },
    nextAction: { recommendation: result.recommendedNextStep },
    safetyAssertions: { targetUnchanged: result.sourceRepository.external ? result.sourceRepository.unchanged : true, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: result.review.providerMetadataPayload?.networkUsed ?? false },
    errors: result.safety.blockingFailures, limitations: result.gaps
  };
}

export function externalResultContract(input: { taskId?: string; targetBranch?: string }, result: ExternalExecutionResult, commands: string[]): Record<string, unknown> {
  const awaiting = result.ownerDecisionGate === "awaiting_owner_decision";
  const publicationFailed = result.publication !== undefined && ["failed", "committed-not-pushed", "pushed-no-pr"].includes(result.publication);
  const failed = publicationFailed || !["passed", "needs owner approval"].includes(result.runforgeCapability);
  const authorityBlocked = !publicationFailed && result.runforgeCapability === "needs owner approval" && !awaiting;
  const status = failed ? "failed" : awaiting ? "awaiting_owner_decision" : authorityBlocked ? "blocked" : "completed";
  const gateStatus = publicationFailed ? "not_available_failed_publication" : failed ? "not_available_failed_evidence" : awaiting ? "awaiting_owner_decision" : authorityBlocked ? "blocked_authority_expansion" : result.ownerDecisionGate;
  const next = publicationFailed ? `Inspect publication evidence for '${result.publication}', correct authentication/push/PR or validation failure, then retry publication without merging.` : failed ? "Inspect failed validation evidence and start a new run; approval cannot override failure." : awaiting ? "Record an explicit owner decision, then run task-run continue." : authorityBlocked ? "Owner must provide expanded authority and start a new run." : "Read summary.md and preserve results.json as evidence.";
  return {
    schemaVersion: 1, contract: "runforge-task-result", taskId: input.taskId ?? result.runId, status,
    targetRepository: { path: result.source.before.path, initialSha: result.source.before.head, finalSha: result.source.after.head, changed: !result.source.unchanged },
    completedWork: [{ id: "baseline", status: result.factoryBaseline }, { id: "disposable-repair", status: result.disposableRepair }],
    validation: commands.map((command) => ({ command, baseline: result.factoryBaseline === "passed" ? "passed" : "failed", afterRepair: result.disposableRepair === "patch-ready" ? "passed" : "failed" })),
    artifacts: { summary: "summary.md", results: "results.json", patch: result.patchPath, ...(input.taskId ? { normalizedTaskSpec: "task-spec.normalized.json" } : {}) },
    git: { branch: input.targetBranch ?? null, commit: result.publicationCommitSha ?? null, pullRequest: result.publicationPrUrl ?? null, merge: null },
    ownerGate: { required: !failed && (awaiting || authorityBlocked), status: gateStatus },
    nextAction: { recommendation: next },
    safetyAssertions: { targetUnchanged: result.source.unchanged, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false },
    errors: publicationFailed ? [`Publication did not complete: ${result.publication}.`] : ["failed", "blocked"].includes(status) ? [result.runforgeCapability] : [], limitations: awaiting ? ["Apply remains blocked until an owner decision is recorded."] : authorityBlocked ? ["Existing authority does not cover the requested next action."] : []
  };
}

export async function readExternalValidationResults(out: string, commands: string[]): Promise<Array<Record<string, unknown>>> {
  const stages = ["baseline", "after-repair", "after-apply", "after-branch-apply", "after-commit", "after-push"] as const;
  const results = await Promise.all(stages.map((stage) => readStage(out, stage)));
  return commands.map((command, index) => ({
    command,
    ...Object.fromEntries(stages.map((stage, stageIndex) => [stage.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), stageResult(results[stageIndex]?.[index])]))
  }));
}

async function readStage(out: string, stage: string): Promise<ExecutorResult[]> {
  return readFile(join(out, "validation", stage, "results.json"), "utf8").then((text) => JSON.parse(text) as ExecutorResult[], () => []);
}

function stageResult(result: ExecutorResult | undefined): Record<string, unknown> | null {
  return result ? { status: result.status, exitCode: result.exitCode, timedOut: result.timedOut, log: result.artifactPaths.commandLog } : null;
}

export function validateTaskResultContract(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Task result must be an object.");
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== 1 || result.contract !== "runforge-task-result") throw new Error("Task result contract/version is invalid.");
  for (const field of ["taskId", "status"]) if (typeof result[field] !== "string" || !(result[field] as string).trim()) throw new Error(`Task result ${field} is required.`);
  for (const field of ["targetRepository", "artifacts", "ownerGate", "nextAction", "safetyAssertions"]) if (typeof result[field] !== "object" || result[field] === null || Array.isArray(result[field])) throw new Error(`Task result ${field} must be an object.`);
  for (const field of ["completedWork", "validation", "errors", "limitations"]) if (!Array.isArray(result[field])) throw new Error(`Task result ${field} must be an array.`);
  const target = result.targetRepository as Record<string, unknown>;
  if (typeof target.changed !== "boolean") throw new Error("Task result targetRepository.changed must be boolean.");
  const safety = result.safetyAssertions as Record<string, unknown>;
  for (const field of ["targetMainMutation", "targetMainPush", "targetPrMerge", "deploy", "databaseAccess", "productionAccess", "secretAccess", "providerCalls"]) if (typeof safety[field] !== "boolean") throw new Error(`Task result safetyAssertions.${field} must be boolean.`);
}
