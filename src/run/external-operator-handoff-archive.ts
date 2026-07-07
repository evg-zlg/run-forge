import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { archiveCounts, archiveFindings, archiveRecommendations, matchesRecord, recordRecommendations, unsafeReasonsFor } from "./external-operator-handoff-archive-helpers.js";
import { renderHandoffArchiveMarkdown, renderHandoffSearchMarkdown } from "./external-operator-handoff-archive-renderer.js";
import { validateHandoffArchiveRecords } from "./external-operator-handoff-archive-validator.js";
import type { HandoffArchiveCounts, HandoffArchiveOptions, HandoffArchiveRecord, HandoffArchiveResult, HandoffArchiveSearchFilters, HandoffArchiveSearchOptions, HandoffArchiveSearchResult } from "./external-operator-handoff-archive-types.js";
export type { HandoffArchiveCounts, HandoffArchiveFormat, HandoffArchiveOptions, HandoffArchiveRecord, HandoffArchiveResult, HandoffArchiveSearchFilters, HandoffArchiveSearchOptions, HandoffArchiveSearchResult, HandoffArchiveValidationResult } from "./external-operator-handoff-archive-types.js";
export { renderHandoffArchiveMarkdown, renderHandoffSearchMarkdown, renderHandoffSearchTable } from "./external-operator-handoff-archive-renderer.js";
export { validateHandoffArchiveFile, validateHandoffArchiveRecords } from "./external-operator-handoff-archive-validator.js";

type JsonObject = Record<string, unknown>;

interface Candidate {
  id: string;
  alpha: string;
  handoffDir?: string;
  handoffJson?: string;
  handoffReadme?: string;
  patch?: string;
  auditResult?: string;
  auditReport?: string;
  decision?: string;
  operatorSummary?: string;
  lifecycleReport?: string;
  repo?: string;
  decisionVerdict?: string;
  validationBefore?: string;
  validationAfter?: string;
  originalRepoMutated?: boolean;
}

export async function buildHandoffArchive(options: HandoffArchiveOptions): Promise<HandoffArchiveResult> {
  const root = resolve(options.root);
  const candidates = new Map<string, Candidate>();
  for (const handoffJson of await findFiles(root, "handoff.json")) {
    upsert(candidates, handoffJson, { id: idFromPath(root, handoffJson), alpha: alphaFor(root, handoffJson), handoffJson, handoffDir: dirname(handoffJson) });
  }
  for (const auditResult of await findFiles(root, "audit-result.json")) {
    const audit = await readOptionalJson<JsonObject>(auditResult);
    const handoffDir = stringValue(audit?.handoffPath);
    const key = handoffDir ? resolve(handoffDir, "handoff.json") : auditResult;
    upsert(candidates, key, { id: idFromPath(root, key), alpha: alphaFor(root, auditResult), auditResult, auditReport: stringValue(objectValue(audit?.artifacts)?.auditReport) || sibling(auditResult, "audit-report.md"), handoffDir });
  }
  for (const decision of await findFiles(root, "operator-decision.json")) {
    const raw = await readOptionalJson<JsonObject>(decision);
    const patch = stringValue(raw?.proposalPatch);
    const key = patch ? resolve(dirname(patch), "handoff.json") : decision;
    upsert(candidates, key, { id: idFromPath(root, key), alpha: alphaFor(root, decision), decision, decisionVerdict: stringValue(raw?.decision) || stringValue(raw?.finalOutcome), originalRepoMutated: booleanValue(objectValue(raw?.apply)?.originalRepoMutated), validationAfter: validationStatus(raw) });
  }
  for (const resultPath of await findFiles(root, "results.json")) {
    await mergeResultsFile(candidates, root, resultPath);
  }

  const records = (await Promise.all([...candidates.values()].map((candidate) => recordFromCandidate(candidate)))).sort((a, b) => a.id.localeCompare(b.id));
  const findings = archiveFindings(records);
  const recommendations = archiveRecommendations(records);
  const archive: HandoffArchiveResult = {
    schemaVersion: "alpha-26-handoff-archive",
    generatedAt: new Date().toISOString(),
    root,
    records,
    counts: archiveCounts(records),
    findings,
    recommendations,
    validation: validateHandoffArchiveRecords(records)
  };
  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "handoff-archive.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    await writeFile(join(out, "handoff-archive.md"), renderHandoffArchiveMarkdown(archive), "utf8");
    await writeFile(join(out, "handoff-archive-records.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }
  return archive;
}

export async function searchHandoffArchive(options: HandoffArchiveSearchOptions): Promise<HandoffArchiveSearchResult> {
  const archivePath = resolve(options.archive);
  const archive = await readHandoffArchive(archivePath);
  const filters = compactFilters(options.filters ?? {});
  const records = archive.records.filter((record) => matchesRecord(record, filters));
  const result: HandoffArchiveSearchResult = {
    schemaVersion: "alpha-26-handoff-search",
    generatedAt: new Date().toISOString(),
    archivePath,
    matchingCount: records.length,
    filters,
    records
  };
  if (options.out) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "handoff-search-results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(out, "handoff-search-results.md"), renderHandoffSearchMarkdown(result), "utf8");
  }
  return result;
}

async function mergeResultsFile(candidates: Map<string, Candidate>, root: string, resultPath: string): Promise<void> {
  const result = await readOptionalJson<JsonObject>(resultPath);
  const attempts = Array.isArray(result?.attempts) ? result.attempts.filter(isObject) : [];
  for (const attempt of attempts) {
    const handoffJson = stringValue(attempt.handoffJson);
    const handoffReadme = stringValue(attempt.handoffReadme);
    const auditResult = stringValue(attempt.handoffAuditResult) || stringValue(objectValue(result?.replay)?.auditResult);
    const sourceHandoff = stringValue(result?.sourceHandoffPath);
    const key = handoffJson || (sourceHandoff ? resolve(sourceHandoff, "handoff.json") : resultPath);
    upsert(candidates, key, {
      id: stringValue(attempt.id) || idFromPath(root, key),
      alpha: alphaFor(root, resultPath),
      handoffJson,
      handoffDir: handoffJson ? dirname(handoffJson) : sourceHandoff,
      handoffReadme,
      patch: stringValue(attempt.proposalPatch),
      auditResult,
      auditReport: stringValue(attempt.handoffAuditReport) || stringValue(objectValue(result?.replay)?.auditReport),
      repo: stringValue(attempt.repo) || stringValue(objectValue(result?.originalRepo)?.path),
      decisionVerdict: decisionFromAttempt(stringValue(attempt.decision)),
      validationBefore: stringValue(attempt.validationBefore),
      validationAfter: stringValue(attempt.validationAfter),
      originalRepoMutated: booleanValue(attempt.originalRepoMutated),
      lifecycleReport: stringValue(objectValue(result?.visibility)?.lifecycleReport)
    });
  }
}

async function recordFromCandidate(candidate: Candidate): Promise<HandoffArchiveRecord> {
  const handoffDir = candidate.handoffDir ? resolve(candidate.handoffDir) : (candidate.handoffJson ? dirname(resolve(candidate.handoffJson)) : "unknown");
  const handoffJson = candidate.handoffJson ? resolve(candidate.handoffJson) : (handoffDir !== "unknown" ? join(handoffDir, "handoff.json") : "unknown");
  const handoff = handoffJson !== "unknown" ? await readOptionalJson<JsonObject>(handoffJson) : null;
  const audit = candidate.auditResult ? await readOptionalJson<JsonObject>(candidate.auditResult) : null;
  const acceptedForm = handoffDir !== "unknown" ? await readOptionalJson<JsonObject>(join(handoffDir, "decision-form.accepted.json")) : null;
  const rejectedForm = handoffDir !== "unknown" ? await readOptionalJson<JsonObject>(join(handoffDir, "decision-form.rejected.json")) : null;
  const repoPath = candidate.repo || stringValue(objectValue(handoff?.sourceRepo)?.path) || stringValue(objectValue(audit?.sourceRepo)?.path) || "unknown";
  const auditStatus = stringValue(audit?.status) || stringValue(candidate.auditResult ? "unknown" : "") || "missing";
  const decisionVerdict = candidate.decisionVerdict || decisionFromForms(acceptedForm, rejectedForm) || decisionFromAudit(audit) || "unknown";
  const validationBefore = candidate.validationBefore || "unknown";
  const validationAfter = candidate.validationAfter || stringValue(objectValue(audit?.replay)?.validationStatus) || validationStatus(acceptedForm) || "unknown";
  const unsafeReasons = unsafeReasonsFor(handoff, audit);
  const safetyStatus = unsafeReasons.length > 0 ? "unsafe" : (handoff || audit ? "safe" : "unknown");
  const patchPath = candidate.patch || childPath(handoffDir, stringValue(objectValue(handoff?.proposal)?.patchPath)) || "unknown";
  const findings = [
    ...(handoffJson !== "unknown" && !(await exists(handoffJson)) ? ["handoff.json is referenced but missing"] : []),
    ...(patchPath !== "unknown" && !(await exists(patchPath)) ? ["patch path missing when proposal indicates a patch"] : []),
    ...unsafeReasons.map((reason) => `unsafe: ${reason}`)
  ];
  return {
    id: stableId(candidate),
    repoPath,
    repoName: repoName(repoPath),
    handoffPath: handoffJson,
    handoffReadmePath: candidate.handoffReadme || childPath(handoffDir, "README.md") || "unknown",
    patchPath,
    auditResultPath: candidate.auditResult || stringValue(objectValue(audit?.artifacts)?.auditResult) || "unknown",
    auditReportPath: candidate.auditReport || stringValue(objectValue(audit?.artifacts)?.auditReport) || "unknown",
    decisionPath: candidate.decision || "unknown",
    operatorSummaryPath: candidate.operatorSummary || stringValue(objectValue(handoff?.evidence)?.operatorSummaryPath) || "unknown",
    lifecycleReportPath: candidate.lifecycleReport || stringValue(objectValue(handoff?.evidence)?.lifecycleReportPath) || "unknown",
    auditStatus,
    decisionVerdict,
    validationBefore,
    validationAfter,
    originalRepoMutated: candidate.originalRepoMutated ?? booleanValue(objectValue(audit?.sourceRepo)?.originalRepoMutated) ?? booleanValue(objectValue(handoff?.sourceRepo)?.originalRepoMutated) ?? false,
    safetyStatus,
    unsafeReasons,
    lifecycleRefs: [candidate.lifecycleReport || "", stringValue(objectValue(handoff?.evidence)?.lifecycleReportPath)].filter(Boolean),
    validationCommands: [stringValue(objectValue(handoff?.validation)?.command)].filter(Boolean),
    createdFromAlpha: candidate.alpha,
    findings,
    recommendations: recordRecommendations(repoName(repoPath), decisionVerdict, auditStatus, safetyStatus, unsafeReasons)
  };
}

function upsert(candidates: Map<string, Candidate>, key: string, next: Partial<Candidate> & { id: string; alpha: string }): void {
  const resolved = resolve(key);
  const current = candidates.get(resolved) ?? { id: next.id, alpha: next.alpha };
  candidates.set(resolved, { ...current, ...stripEmpty(next), id: current.id || next.id, alpha: latestAlpha(current.alpha, next.alpha) });
}

function stripEmpty<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as Partial<T>;
}

function compactFilters(filters: HandoffArchiveSearchFilters): HandoffArchiveSearchFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "")) as HandoffArchiveSearchFilters;
}

async function readHandoffArchive(path: string): Promise<HandoffArchiveResult> {
  const archive = JSON.parse(await readFile(path, "utf8")) as HandoffArchiveResult;
  if (archive.schemaVersion !== "alpha-26-handoff-archive" || !Array.isArray(archive.records)) throw new Error(`Invalid handoff archive at ${path}`);
  return archive;
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, async (path) => {
    if (basename(path) === fileName) found.push(path);
  });
  return found.sort();
}

async function walk(path: string, visit: (path: string) => Promise<void>): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) return visit(path);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await walk(join(path, entry), visit);
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function childPath(root: string, path: string): string {
  if (!path || root === "unknown") return "";
  return resolve(root, path);
}

function sibling(path: string, name: string): string {
  return join(dirname(path), name);
}

function stableId(candidate: Candidate): string {
  return slug(candidate.id || candidate.handoffJson || candidate.auditResult || candidate.repo || "handoff");
}

function idFromPath(root: string, path: string): string {
  return slug(relative(root, resolve(path)).replace(/\/(?:handoff|audit-result|operator-decision|results)\.json$/, ""));
}

function slug(value: string): string {
  return value.replaceAll(sep, "/").replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^\/+|\/+$/g, "").replaceAll("/", "__") || "handoff";
}

function alphaFor(root: string, path: string): string {
  const first = relative(root, resolve(path)).split(sep)[0];
  return first || "unknown";
}

function latestAlpha(a: string, b: string): string {
  return a.localeCompare(b, undefined, { numeric: true }) >= 0 ? a : b;
}

function decisionFromAttempt(value: string): string {
  if (value.includes("accepted")) return "accepted";
  if (value.includes("rejected")) return "rejected";
  if (value.includes("audit_passed")) return "accepted";
  if (value.includes("audit_failed")) return "rejected";
  return value || "unknown";
}

function decisionFromForms(accepted: JsonObject | null, rejected: JsonObject | null): string {
  if (accepted?.decision === "accepted" && accepted.afterValidation === "passed") return "accepted";
  if (rejected?.decision === "rejected") return "rejected";
  return "";
}

function decisionFromAudit(audit: JsonObject | null): string {
  if (!audit) return "";
  return audit.status === "passed" ? "accepted" : audit.status === "failed" ? "rejected" : "";
}

function validationStatus(value: JsonObject | null): string {
  if (!value) return "";
  if (value.afterValidation) return stringValue(value.afterValidation);
  const validation = objectValue(value.validation);
  if (validation?.passed === true) return "passed";
  return stringValue(validation?.status);
}

function repoName(path: string): string {
  return path && path !== "unknown" ? basename(path) : "unknown";
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(objectValue(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
