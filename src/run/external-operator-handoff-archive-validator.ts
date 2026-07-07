import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findSecretLikeContent } from "./okf-secret-scan.js";
import type { HandoffArchiveRecord, HandoffArchiveResult, HandoffArchiveValidationResult } from "./external-operator-handoff-archive-types.js";

export async function validateHandoffArchiveFile(path: string): Promise<HandoffArchiveValidationResult> {
  return validateHandoffArchiveRecords((await readHandoffArchive(resolve(path))).records);
}

export function validateHandoffArchiveRecords(records: HandoffArchiveRecord[]): HandoffArchiveValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) errors.push(`duplicate record id: ${record.id}`);
    seen.add(record.id);
    if (!record.handoffPath || record.handoffPath === "unknown") errors.push(`${record.id} missing handoff path`);
    if (record.auditStatus === "passed" && (!record.auditResultPath || record.auditResultPath === "unknown")) errors.push(`${record.id} audit passed but audit result path is missing`);
    if (record.decisionVerdict === "accepted" && record.validationAfter !== "passed") errors.push(`${record.id} accepted decision requires validationAfter=passed`);
    if (record.originalRepoMutated === true) errors.push(`${record.id} original repo mutated true`);
    if (record.safetyStatus === "unsafe" && record.unsafeReasons.length === 0) errors.push(`${record.id} unsafe status requires reasons`);
    if (record.patchPath === "missing" || record.findings.some((finding) => finding.includes("patch path missing"))) errors.push(`${record.id} patch path missing when proposal indicates a patch`);
    for (const path of archivePaths(record)) {
      if (path && path !== "unknown" && path !== "missing" && malformedLocalPath(path)) errors.push(`${record.id} malformed local path: ${path}`);
    }
    for (const finding of findSecretLikeContent(JSON.stringify(record))) errors.push(`${record.id} secret-like content matched ${finding}`);
  }
  return { passed: errors.length === 0, errors };
}

async function readHandoffArchive(path: string): Promise<HandoffArchiveResult> {
  const archive = JSON.parse(await readFile(path, "utf8")) as HandoffArchiveResult;
  if (archive.schemaVersion !== "alpha-26-handoff-archive" || !Array.isArray(archive.records)) throw new Error(`Invalid handoff archive at ${path}`);
  return archive;
}

function archivePaths(record: HandoffArchiveRecord): string[] {
  return [record.handoffPath, record.handoffReadmePath, record.patchPath, record.auditResultPath, record.auditReportPath, record.decisionPath, record.operatorSummaryPath, record.lifecycleReportPath];
}

function malformedLocalPath(path: string): boolean {
  return path.includes("\0") || /^(?:https?:|git@)/.test(path) || path.includes("..\\") || /^[A-Za-z]:\\/.test(path);
}
