import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalExecutionResult } from "../run/external-execution.js";
import type { TaskRunResult } from "../run/task-run-harness.js";
import type { ExecutorResult } from "../run/task-run-executor.js";
import {
  type ExecutionAgreement, type ExecutionAgreementStatus, type ExecutionParty, type ExecutionPhaseId, type ExecutionProfile,
} from "./execution-agreement.js";

export { validateTaskResultContract } from "./task-result-validation.js";

export const RUNFORGE_COMPLETION_STATUSES = [
  "runforge_scope_completed", "workflow_completed", "awaiting_external_session", "awaiting_owner",
  "blocked_by_capability", "blocked_by_policy", "failed",
] as const;

const AGREEMENT_ID_PATTERN = /^ea_v1_[a-f0-9]{24}$/;

export type RunForgeCompletionStatus = (typeof RUNFORGE_COMPLETION_STATUSES)[number];
export type HandoffProfile = Extract<ExecutionProfile, "assist-only" | "local-ready">;
export type NextParty = Exclude<ExecutionParty, "nobody">;

export type ResultPhaseOwnership = { phaseId: ExecutionPhaseId; responsibleParty: ExecutionParty };
export type ResultDelegatedPhase = { phaseId: ExecutionPhaseId; responsibleParty: Exclude<ExecutionParty, "runforge" | "nobody"> };
export type ResultAwaitingPhase = ResultDelegatedPhase & { prerequisites: string[] };

export type AgreementResultSummary = {
  agreementId: string;
  profile: ExecutionProfile;
  requestedProfile: ExecutionProfile;
  effectiveProfile: ExecutionProfile;
  status: ExecutionAgreementStatus;
  phaseOwnership: ResultPhaseOwnership[];
  runforgeCompletedPhases: ExecutionPhaseId[];
  delegatedPhases: ResultDelegatedPhase[];
  awaitingPhases: ResultAwaitingPhase[];
};

export type ResultGate = { name: string; status: "satisfied" | "pending" | "blocked"; evidence: string[] };
export type ResultEvidence = { kind: "artifact" | "command" | "commit" | "patch" | "review" | "other"; reference: string; summary: string };

export type ResultNextAction = { party: NextParty; exactAction: string; gates: ResultGate[]; evidence: ResultEvidence[] };
export type HandoffValidation = { command: string; status: "passed" | "failed" | "not_run"; exitCode: number | null; evidence: string[] };

export type HandoffSafety = {
  targetMainMutation: false; targetMainPush: false; targetPrMerge: false; deploy: false;
  databaseAccess: false; productionAccess: false; secretAccess: false;
  providerCalls: boolean; notes: string[];
};

export type NormalizedHandoffPackage = {
  profile: HandoffProfile;
  summary: string;
  changedFiles: string[];
  patch: string | null;
  branch: string | null;
  commit: string | null;
  validation: HandoffValidation[];
  findings: string[];
  risks: string[];
  nextActions: ResultNextAction[];
  publicationInstructions: string[];
  ciCommands: string[];
  safety: HandoffSafety;
  targetSha: string | null;
  baseSha: string | null;
};

export type AgreementAwareTaskResult = {
  schemaVersion: 1;
  contract: "runforge-task-result";
  taskId: string;
  status: RunForgeCompletionStatus;
  agreement: AgreementResultSummary;
  handoff: NormalizedHandoffPackage;
  next: ResultNextAction;
};

export type NormalizedHandoffInput = Omit<NormalizedHandoffPackage, "summary" | "changedFiles" | "validation" | "findings" | "risks" | "nextActions" | "publicationInstructions" | "ciCommands" | "safety"> & {
  summary: string;
  changedFiles?: readonly string[];
  validation?: readonly (Omit<HandoffValidation, "evidence"> & { evidence?: readonly string[] })[];
  findings?: readonly string[];
  risks?: readonly string[];
  nextActions: readonly (Omit<ResultNextAction, "gates" | "evidence"> & { gates?: readonly ResultGate[]; evidence?: readonly ResultEvidence[] })[];
  publicationInstructions?: readonly string[];
  ciCommands?: readonly string[];
  safety?: Partial<HandoffSafety>;
};

export function buildResultNextAction(
  input: Omit<ResultNextAction, "gates" | "evidence"> & { gates?: readonly ResultGate[]; evidence?: readonly ResultEvidence[] },
): ResultNextAction {
  return normalizeNextAction(input, "nextAction");
}

export const buildNextAction = buildResultNextAction;

/** Projects an agreement into stable, phase-ordered result fields. External ownership remains a handoff, never a failure. */
export function buildAgreementResultSummary(agreement: ExecutionAgreement): AgreementResultSummary {
  const requested = agreement.phases.filter((phase) => phase.requested);
  return {
    agreementId: requiredAgreementId(agreement.agreementId, "agreement.agreementId"),
    profile: agreement.profile,
    requestedProfile: agreement.profile,
    effectiveProfile: agreement.profile,
    status: agreement.status,
    phaseOwnership: requested.map(({ phaseId, responsibleParty }) => ({ phaseId, responsibleParty })),
    runforgeCompletedPhases: requested
      .filter((phase) => phase.responsibleParty === "runforge" && phase.status === "completed")
      .map((phase) => phase.phaseId),
    delegatedPhases: requested.flatMap((phase): ResultDelegatedPhase[] =>
      phase.responsibleParty === "runforge" || phase.responsibleParty === "nobody"
        ? []
        : [{ phaseId: phase.phaseId, responsibleParty: phase.responsibleParty }]),
    awaitingPhases: requested.flatMap((phase): ResultAwaitingPhase[] =>
      phase.status === "completed" || phase.responsibleParty === "runforge" || phase.responsibleParty === "nobody"
        ? []
        : [{ phaseId: phase.phaseId, responsibleParty: phase.responsibleParty, prerequisites: normalizedStrings(phase.prerequisites) }]),
  };
}

export const buildAgreementSummary = buildAgreementResultSummary;

/** Builds the portable assist-only/local-ready package used by another session without relying on ambient context. */
export function buildNormalizedHandoffPackage(input: NormalizedHandoffInput): NormalizedHandoffPackage {
  if (input.profile !== "assist-only" && input.profile !== "local-ready") throw new Error(`Unsupported handoff profile '${String(input.profile)}'.`);
  if (input.profile === "assist-only" && input.branch !== null) throw new Error("handoff.branch must be null for assist-only handoffs.");
  if (input.profile === "local-ready" && input.branch === null) throw new Error("handoff.branch is required for local-ready handoffs.");
  for (const field of ["targetMainMutation", "targetMainPush", "targetPrMerge", "deploy", "databaseAccess", "productionAccess", "secretAccess"] as const) {
    if (input.safety?.[field] !== undefined && input.safety[field] !== false) throw new Error(`handoff.safety.${field} must be false.`);
  }
  if (input.safety?.providerCalls !== undefined && typeof input.safety.providerCalls !== "boolean") throw new Error("handoff.safety.providerCalls must be boolean.");
  const nextActions = input.nextActions.map((action, index) => normalizeNextAction(action, `handoff.nextActions[${index}]`));
  if (nextActions.length === 0) throw new Error("handoff.nextActions must contain at least one exact action.");
  const validation = (input.validation ?? []).map((item, index) => {
    if (!["passed", "failed", "not_run"].includes(item.status)) throw new Error(`handoff.validation[${index}].status is invalid.`);
    if (item.exitCode !== null && !Number.isInteger(item.exitCode)) throw new Error(`handoff.validation[${index}].exitCode must be an integer or null.`);
    return {
      command: requiredText(item.command, `handoff.validation[${index}].command`),
      status: item.status,
      exitCode: item.exitCode,
      evidence: normalizedStrings(item.evidence),
    };
  });
  return {
    profile: input.profile,
    summary: requiredText(input.summary, "handoff.summary"),
    changedFiles: normalizedStrings(input.changedFiles),
    patch: nullableText(input.patch, "handoff.patch"),
    branch: nullableText(input.branch, "handoff.branch"),
    commit: nullableText(input.commit, "handoff.commit"),
    validation,
    findings: normalizedStrings(input.findings),
    risks: normalizedStrings(input.risks),
    nextActions,
    publicationInstructions: normalizedStrings(input.publicationInstructions),
    ciCommands: normalizedStrings(input.ciCommands),
    safety: {
      targetMainMutation: false,
      targetMainPush: false,
      targetPrMerge: false,
      deploy: false,
      databaseAccess: false,
      productionAccess: false,
      secretAccess: false,
      providerCalls: input.safety?.providerCalls ?? false,
      notes: normalizedStrings(input.safety?.notes),
    },
    targetSha: nullableText(input.targetSha, "handoff.targetSha"),
    baseSha: nullableText(input.baseSha, "handoff.baseSha"),
  };
}

export const buildHandoffPackage = buildNormalizedHandoffPackage;

export function buildAgreementAwareTaskResult(input: {
  taskId: string;
  status: RunForgeCompletionStatus;
  agreement: ExecutionAgreement;
  handoff: NormalizedHandoffInput;
  next: Omit<ResultNextAction, "gates" | "evidence"> & { gates?: readonly ResultGate[]; evidence?: readonly ResultEvidence[] };
}): AgreementAwareTaskResult {
  if (!(RUNFORGE_COMPLETION_STATUSES as readonly string[]).includes(input.status)) throw new Error(`Unknown task result status '${String(input.status)}'.`);
  return {
    schemaVersion: 1,
    contract: "runforge-task-result",
    taskId: requiredText(input.taskId, "taskId"),
    status: input.status,
    agreement: buildAgreementResultSummary(input.agreement),
    handoff: buildNormalizedHandoffPackage(input.handoff),
    next: normalizeNextAction(input.next, "next"),
  };
}

export function completionStatusForIntent(input: { executionStatus: string; implementationExpected: boolean; targetChanged: boolean; patch?: string | null; commit?: string | null; pullRequest?: string | null }): string {
  if (input.executionStatus !== "completed" || !input.implementationExpected) return input.executionStatus;
  return input.targetChanged || input.patch || input.commit || input.pullRequest ? "completed" : "implementation_not_started";
}

/** Classifies a terminal agreement result without treating delegated phases as execution failures. */
export function completionStatusForAgreement(agreement: ExecutionAgreement, failed = false): RunForgeCompletionStatus {
  if (failed) return "failed";
  const conflict = agreement.conflicts[0];
  if (conflict?.kind === "unavailable") return "blocked_by_capability";
  if (conflict?.kind === "policy_denied") return "blocked_by_policy";
  if (conflict?.kind === "unauthorized") return "awaiting_owner";
  const requested = agreement.phases.filter((phase) => phase.requested);
  if (requested.every((phase) => phase.status === "completed")) return "workflow_completed";
  if (requested.some((phase) => phase.responsibleParty === "runforge" && phase.status !== "completed")) return "failed";
  const awaiting = requested.find((phase) => phase.status !== "completed" && phase.responsibleParty !== "runforge");
  return awaiting?.responsibleParty === "external_session" ? "awaiting_external_session"
    : awaiting?.responsibleParty === "owner" ? "awaiting_owner" : "runforge_scope_completed";
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

function normalizeNextAction(input: Omit<ResultNextAction, "gates" | "evidence"> & { gates?: readonly ResultGate[]; evidence?: readonly ResultEvidence[] }, name: string): ResultNextAction {
  if (!["runforge", "external_session", "owner", "external_system"].includes(input.party)) throw new Error(`${name}.party is invalid.`);
  return {
    party: input.party,
    exactAction: requiredText(input.exactAction, `${name}.exactAction`),
    gates: (input.gates ?? []).map((gate, index) => {
      if (!["satisfied", "pending", "blocked"].includes(gate.status)) throw new Error(`${name}.gates[${index}].status is invalid.`);
      return { name: requiredText(gate.name, `${name}.gates[${index}].name`), status: gate.status, evidence: normalizedStrings(gate.evidence) };
    }),
    evidence: (input.evidence ?? []).map((item, index) => {
      if (!["artifact", "command", "commit", "patch", "review", "other"].includes(item.kind)) throw new Error(`${name}.evidence[${index}].kind is invalid.`);
      return {
        kind: item.kind,
        reference: requiredText(item.reference, `${name}.evidence[${index}].reference`),
        summary: requiredText(item.summary, `${name}.evidence[${index}].summary`),
      };
    }),
  };
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function requiredAgreementId(value: string, name: string): string {
  const normalized = value.trim();
  if (!AGREEMENT_ID_PATTERN.test(normalized)) throw new Error(`${name} is invalid.`);
  return normalized;
}

function nullableText(value: string | null, name: string): string | null {
  if (value === null) return null;
  return requiredText(value, name);
}

function normalizedStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}
