import type { ExecutionAgreement } from "../product/execution-agreement.js";
import type { AgreementLifecycleProjection, ControlTaskRecord } from "./contracts.js";

const publicDiagnosticBytes = 8_192;
const publicStringBytes = 65_536;
export const publicResultLimits = { maxDiagnosticBytes: publicDiagnosticBytes, maxStringBytes: publicStringBytes } as const;

export function projectAgreementLifecycle(task: Pick<ControlTaskRecord, "executionAgreement" | "ownerGate" | "publicationGate" | "progress">, result?: Record<string, unknown>): AgreementLifecycleProjection | undefined {
  const agreement = task.executionAgreement;
  if (!agreement) return undefined;
  const workflow = object(result?.workflow);
  const directSummary = object(result?.agreement); const workflowSummary = object(workflow.agreement); const hasResultSummary = Object.keys(directSummary).length > 0 || Object.keys(workflowSummary).length > 0;
  const summary = Object.keys(directSummary).length ? directSummary : workflowSummary;
  const next = object(Object.keys(object(result?.next)).length ? result?.next : workflow.next);
  const completed = acceptedRunforgeCompletions(agreement, summary.runforgeCompletedPhases ?? (hasResultSummary ? undefined : task.progress.agreement?.runforgeCompletedPhases));
  const delegated = acceptedDelegatedPhases(agreement);
  const awaiting = acceptedAwaitingPhases(agreement, summary.awaitingPhases ?? (hasResultSummary ? undefined : task.progress.agreement?.awaitingPhases));
  const current = firstOutstandingPhase(agreement, completed);
  const nextParty = current?.responsibleParty === "nobody" ? null : current?.responsibleParty ?? null;
  const legacyNext = object(result?.nextAction);
  const currentReason = current ? agreement.phases.find((phase) => phase.phaseId === current.phaseId)?.reason ?? null : null;
  return {
    schemaVersion: agreement.schemaVersion, agreementId: agreement.agreementId, profile: agreement.profile,
    currentPhase: current?.phaseId ?? null, responsibleParty: current?.responsibleParty ?? null,
    runforgeCompletedPhases: completed, delegatedPhases: delegated, awaitingPhases: awaiting,
    nextParty, nextAction: textValue(next.exactAction) ?? textValue(legacyNext.recommendation) ?? currentReason,
    conflicts: agreement.conflicts.map((conflict) => ({ ...conflict })), ownerGate: { ...task.ownerGate }, publicationGate: { ...task.publicationGate },
  };
}

export function settleAcceptedAgreement(result: Record<string, unknown>, agreement: ExecutionAgreement): Record<string, unknown> {
  const settled = structuredClone(result);
  const ownerGated = object(settled.ownerGate).required === true;
  const workflow = object(settled.workflow);
  const direct = object(settled.agreement); const nested = object(workflow.agreement);
  const source = Object.keys(direct).length ? direct : nested;
  const hasDirect = Object.keys(direct).length > 0; const hasNested = Object.keys(nested).length > 0;
  if (!hasDirect && !hasNested && !Object.keys(workflow).length) return settled;
  const completed = acceptedRunforgeCompletions(agreement, source.runforgeCompletedPhases);
  const requested = agreement.phases.filter((phase) => phase.requested);
  const awaiting = acceptedAwaitingPhases(agreement, source.awaitingPhases);
  const current = firstOutstandingPhase(agreement, completed);
  const terminalStatus = lifecycleStatus(current);
  const summary = {
    ...source,
    agreementId: agreement.agreementId,
    profile: agreement.profile,
    requestedProfile: agreement.profile,
    effectiveProfile: agreement.profile,
    status: current ? "in_progress" : "completed",
    phaseOwnership: requested.map(({ phaseId, responsibleParty }) => ({ phaseId, responsibleParty })),
    runforgeCompletedPhases: completed,
    delegatedPhases: acceptedDelegatedPhases(agreement),
    awaitingPhases: awaiting,
  };
  if (hasDirect) settled.agreement = summary;
  else settled.workflow = { ...workflow, agreement: summary };
  if (current) {
    const next = hasDirect ? object(settled.next) : object(workflow.next);
    const projected = awaiting.find((phase) => phase.phaseId === current.phaseId);
    const prerequisites = projected?.prerequisites ?? current.prerequisites;
    const gates = mergeResultGates(prerequisites, next.gates);
    const correctedNext = { ...next, party: current.responsibleParty, gates };
    if (hasDirect) settled.next = correctedNext;
    else settled.workflow = { ...object(settled.workflow), next: correctedNext };
  }
  if (hasDirect) settled.status = ownerGated ? "awaiting_owner" : terminalStatus;
  if (Object.keys(workflow).length) settled.workflow = { ...object(settled.workflow), status: ownerGated ? "awaiting_owner" : terminalStatus };
  return settled;
}

export function boundPublicResult(result: Record<string, unknown>): { result: Record<string, unknown>; truncatedFields: string[] } {
  const truncatedFields: string[] = [];
  const visit = (value: unknown, path: string[]): unknown => {
    if (typeof value === "string") {
      const key = path.at(-1) ?? ""; const limit = key === "stdout" || key === "stderr" ? publicDiagnosticBytes : publicStringBytes;
      if (Buffer.byteLength(value) <= limit) return redactPublicText(value);
      truncatedFields.push(path.join("."));
      return redactPublicText(`${Buffer.from(value).subarray(0, limit).toString("utf8")}\n[TRUNCATED: full output remains in the referenced artifact]`);
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, String(index)]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
    return value;
  };
  return { result: visit(result, []) as Record<string, unknown>, truncatedFields };
}

export function redactPublicValue<T>(value: T): T {
  const visit = (item: unknown, path: string[]): unknown => {
    // A corrected request is replay material. Its direct target is supplied by
    // the caller, not discovered by RunForge, so preserving it is required for
    // an exact HTTP retry. Keep this exception structurally narrow.
    if (typeof item === "string") return correctedTargetRepositoryPath(path) ? item : redactPublicText(item);
    if (Array.isArray(item)) return item.map((child, index) => visit(child, [...path, String(index)]));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, [...path, key])]));
    return item;
  };
  return visit(value, []) as T;
}
function correctedTargetRepositoryPath(path: string[]): boolean { return path.join(".") === "error.details.correctedRequest.taskSpec.target.repository"; }

/** A small stable projection for HTTP clients; structural inspection never sets performed=true. */
export function normalizedSemanticReview(result: Record<string, unknown>): Record<string, unknown> | null {
  const review = object(object(result.review).semantic);
  if (!Object.keys(review).length) return null;
  const calls = Array.isArray(result.providerCalls) ? result.providerCalls.map(object).filter((call) => call.purpose === "semantic-review" || call.phase === "reviewer") : [];
  const providerCalls = calls.filter((call) => call.providerCalls === true).length;
  const reviewer = semanticReviewerIdentity(review.reviewer);
  const findings = semanticFindings(review.findings);
  const limitations = semanticLimitations(review.limitations);
  const malformed = reviewer === null || findings === null || limitations === null;
  const invocationBacked = reviewer !== null && calls.some((call) => semanticCallMatchesReviewer(call, reviewer));
  const performed = !malformed && review.performed === true && review.status === "completed" && invocationBacked;
  const failure = malformed ? "Semantic review result was malformed or lacked a provider-backed reviewer identity." : review.status === "completed" && !invocationBacked ? "Semantic review completion lacked a matching successful provider invocation." : null;
  return {
    performed,
    reviewer: reviewer ?? { provider: null, model: null, invocationId: null },
    providerCalls,
    findings: performed ? findings : [],
    limitations: [...(limitations ?? []), ...(failure ? [failure] : [])],
    outcome: performed ? "semantic_review_completed" : malformed || review.status === "unavailable" || review.status === "completed" ? "reviewer_unavailable" : "semantic_review_not_completed",
  };
}

const semanticSeverities = new Set(["critical", "high", "medium", "low", "info"]);
function semanticReviewerIdentity(value: unknown): { provider: string; model: string | null; invocationId: string } | null {
  const reviewer = object(value);
  return nonEmpty(reviewer.provider) && (reviewer.model === null || nonEmpty(reviewer.model)) && nonEmpty(reviewer.invocationId)
    ? { provider: reviewer.provider as string, model: reviewer.model as string | null, invocationId: reviewer.invocationId as string }
    : null;
}
function semanticCallMatchesReviewer(call: Record<string, any>, reviewer: { provider: string; model: string | null; invocationId: string }): boolean {
  return call.providerCalls === true && call.networkAuthorized === true && call.success === true && call.exitCode === 0
    && call.provider === reviewer.provider && call.model === reviewer.model && call.invocationId === reviewer.invocationId;
}
function semanticFindings(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const findings: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const finding = object(item);
    if (!semanticSeverities.has(String(finding.severity)) || !["file", "location", "category", "evidence", "recommendation"].every((field) => nonEmpty(finding[field])) || typeof finding.blocking !== "boolean") return null;
    findings.push({ severity: finding.severity, file: finding.file, location: finding.location, category: finding.category, evidence: finding.evidence, recommendation: finding.recommendation, blocking: finding.blocking });
  }
  return findings;
}
function semanticLimitations(value: unknown): string[] | null { return Array.isArray(value) && value.every(nonEmpty) ? [...new Set(value as string[])] : null; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }

function redactPublicText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, "$1[REDACTED]")
    .replace(/(?<![A-Za-z0-9_.@-])(?:\/[A-Za-z0-9_.@-]+){2,}/g, (path) => path.startsWith("/v1/") || path.startsWith("/schemas/") || path.startsWith("/.well-known/") ? path : "[internal path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`,;:]+\\)*[^\\\s"'`,;:]+/g, "[internal path]");
}

function phaseIds(value: unknown): AgreementLifecycleProjection["runforgeCompletedPhases"] { return Array.isArray(value) ? value.filter((item): item is AgreementLifecycleProjection["runforgeCompletedPhases"][number] => typeof item === "string") : []; }
function acceptedRunforgeCompletions(agreement: ExecutionAgreement, claimed: unknown): AgreementLifecycleProjection["runforgeCompletedPhases"] { const claims = new Set(phaseIds(claimed)); return agreement.phases.filter((phase) => phase.requested && phase.responsibleParty === "runforge" && (phase.status === "completed" || claims.has(phase.phaseId))).map((phase) => phase.phaseId); }
function acceptedDelegatedPhases(agreement: ExecutionAgreement): AgreementLifecycleProjection["delegatedPhases"] { return agreement.phases.flatMap((phase) => phase.requested && phase.responsibleParty !== "runforge" && phase.responsibleParty !== "nobody" ? [{ phaseId: phase.phaseId, responsibleParty: phase.responsibleParty }] : []); }
function acceptedAwaitingPhases(agreement: ExecutionAgreement, projected: unknown): AgreementLifecycleProjection["awaitingPhases"] { const evidence = new Map(Array.isArray(projected) ? projected.flatMap((item) => { const phase = object(item); return typeof phase.phaseId === "string" ? [[phase.phaseId, phase] as const] : []; }) : []); return agreement.handoffs.map(({ phaseId, responsibleParty, prerequisites }) => ({ phaseId, responsibleParty, prerequisites: mergePrerequisites(prerequisites, evidence.get(phaseId)?.prerequisites) })); }
function firstOutstandingPhase(agreement: ExecutionAgreement, completed: AgreementLifecycleProjection["runforgeCompletedPhases"]): ExecutionAgreement["phases"][number] | undefined { return agreement.phases.find((phase) => phase.requested && phase.status !== "completed" && (phase.responsibleParty !== "runforge" || !completed.includes(phase.phaseId))); }
function lifecycleStatus(current: ExecutionAgreement["phases"][number] | undefined): "workflow_completed" | "awaiting_external_session" | "awaiting_owner" | "runforge_scope_completed" | "failed" { if (!current) return "workflow_completed"; if (current.responsibleParty === "external_session") return "awaiting_external_session"; if (current.responsibleParty === "owner") return "awaiting_owner"; return current.responsibleParty === "external_system" ? "runforge_scope_completed" : "failed"; }
function mergeResultGates(prerequisites: readonly string[], projected: unknown): Array<Record<string, unknown>> { const source = new Map(Array.isArray(projected) ? projected.flatMap((item) => { const gate = object(item); return typeof gate.name === "string" ? [[gate.name, gate] as const] : []; }) : []); return prerequisites.map((name) => ({ name, status: source.get(name)?.status ?? "pending", evidence: Array.isArray(source.get(name)?.evidence) ? source.get(name)!.evidence : [] })); }
function mergePrerequisites(accepted: readonly string[], projected: unknown): string[] { return [...new Set([...accepted, ...(Array.isArray(projected) ? projected.map(String) : [])])]; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
