import { execFile, exec } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createRunId } from "../core/trajectory.js";
import { gitSnapshot, mutationVerdictFor } from "./external-command-check-git.js";
import { validateOperatorHandoffPacket } from "./external-operator-handoff-validator.js";
import { renderOperatorHandoffReplayReport } from "./external-operator-handoff-replay-renderer.js";
export { renderOperatorHandoffReplaySummary } from "./external-operator-handoff-replay-renderer.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type JsonObject = Record<string, unknown>;

export interface OperatorHandoffReplayOptions {
  handoff: string;
  out: string;
  auditId?: string;
  timeoutMs?: number;
}

export interface OperatorHandoffReplayResult {
  auditId: string;
  handoffPath: string;
  status: "passed" | "failed";
  sourceRepo: {
    path: string;
    headBefore: string | null;
    headAfter: string | null;
    statusBefore: string;
    statusAfter: string;
    originalRepoMutated: boolean;
  };
  replay: {
    worktreePath: string;
    patchApplied: boolean;
    validationRun: boolean;
    validationStatus: "passed" | "failed" | "skipped";
  };
  decisionForms: {
    acceptedValid: boolean;
    rejectedValid: boolean;
  };
  safety: {
    unsafeInstructionsFound: boolean;
    forbiddenTargetsFound: boolean;
    providerUsed: false;
    networkUsed: false;
    dbUsed: false;
    deployUsed: false;
    pushUsed: false;
    mergeUsed: false;
  };
  findings: string[];
  recommendations: string[];
  artifacts: {
    auditReport: string;
    auditResult: string;
    replayLog: string;
  };
}

interface ReplayLogEntry {
  step: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export async function replayOperatorHandoffPacket(options: OperatorHandoffReplayOptions): Promise<OperatorHandoffReplayResult> {
  const auditId = options.auditId ?? createRunId();
  const handoffDir = resolve(options.handoff);
  const out = resolve(options.out);
  const findings: string[] = [];
  const recommendations: string[] = [];
  const log: ReplayLogEntry[] = [];
  const auditReport = join(out, "audit-report.md");
  const auditResult = join(out, "audit-result.json");
  const replayLog = join(out, "replay-log.json");
  await mkdir(out, { recursive: true });

  const handoff = await readOptionalJson<JsonObject>(join(handoffDir, "handoff.json"));
  const sourcePath = stringValue(objectValue(handoff?.sourceRepo)?.path);
  const sourceBefore = sourcePath ? await gitSnapshot(sourcePath) : { head: null, status: null };
  const replay = {
    worktreePath: join(out, "replay-worktree"),
    patchApplied: false,
    validationRun: false,
    validationStatus: "skipped" as "passed" | "failed" | "skipped"
  };
  const decisionForms = { acceptedValid: false, rejectedValid: false };
  const safety = {
    unsafeInstructionsFound: false,
    forbiddenTargetsFound: false,
    providerUsed: false as const,
    networkUsed: false as const,
    dbUsed: false as const,
    deployUsed: false as const,
    pushUsed: false as const,
    mergeUsed: false as const
  };

  try {
    if (!isUnderTmp(out)) findings.push("audit output path must be under /tmp");
    const packetValidation = await validateOperatorHandoffPacket(handoffDir);
    if (!packetValidation.passed) findings.push(...packetValidation.errors);
    log.push({ step: "packet-validation", status: packetValidation.passed ? "passed" : "failed", detail: packetValidation.errors.join("; ") || "handoff packet structure and safety checks passed" });

    if (!handoff) {
      findings.push("handoff.json could not be read");
    } else {
      const patchPath = resolveHandoffChild(handoffDir, stringValue(objectValue(handoff.proposal)?.patchPath) || "proposal.patch");
      if (!patchPath) findings.push("proposal.patch path escapes handoff directory");
      else {
        await access(patchPath).catch(() => findings.push("proposal.patch is missing"));
        const patchText = await readFile(patchPath, "utf8").catch(() => "");
        const patchPathErrors = unsafePatchPaths(patchText);
        findings.push(...patchPathErrors);
      }

      const instructionText = await readInstructions(handoffDir);
      const instructionFindings = unsafeInstructionFindings(instructionText);
      if (instructionFindings.length > 0) safety.unsafeInstructionsFound = true;
      findings.push(...instructionFindings);

      const validationCommand = stringValue(objectValue(handoff.validation)?.command);
      const validationFindings = unsafeCommandFindings(validationCommand);
      if (validationFindings.length > 0) safety.unsafeInstructionsFound = true;
      findings.push(...validationFindings);

      if (objectValue(handoff.manualApply)?.allowedTarget === "original_repo") {
        safety.forbiddenTargetsFound = true;
        findings.push("handoff allows original_repo as apply target");
      }
      if (objectValue(handoff.sourceRepo)?.originalRepoMutated !== false) findings.push("handoff is missing original repo mutation verdict");

      decisionForms.acceptedValid = await validateAcceptedDecision(join(handoffDir, stringValue(objectValue(handoff.decisionForms)?.accepted) || "decision-form.accepted.json"), findings);
      decisionForms.rejectedValid = await validateRejectedDecision(join(handoffDir, stringValue(objectValue(handoff.decisionForms)?.rejected) || "decision-form.rejected.json"), findings);

      const replaySource = await replaySourceFor(handoffDir, handoff);
      if (!replaySource) {
        findings.push("no disposable replay source was found");
      } else if (!isUnderTmp(replaySource)) {
        safety.forbiddenTargetsFound = true;
        findings.push(`replay source is not disposable /tmp path: ${replaySource}`);
      } else if (resolve(replaySource) === resolve(sourcePath)) {
        safety.forbiddenTargetsFound = true;
        findings.push("replay source resolves to original repo path");
      } else if (findings.length === 0 && patchPath) {
        await rm(replay.worktreePath, { recursive: true, force: true });
        await cp(replaySource, replay.worktreePath, { recursive: true, dereference: false, filter: (source) => basename(source) !== "node_modules" });
        log.push({ step: "create-replay-worktree", status: "passed", detail: replay.worktreePath });
        await execFileAsync("git", ["apply", patchPath], { cwd: replay.worktreePath, timeout: options.timeoutMs ?? 120000 });
        replay.patchApplied = true;
        log.push({ step: "apply-patch", status: "passed", detail: `git apply ${patchPath}` });
        if (validationCommand) {
          replay.validationRun = true;
          try {
            await execAsync(validationCommand, { cwd: replay.worktreePath, timeout: options.timeoutMs ?? 120000 });
            replay.validationStatus = "passed";
            log.push({ step: "validation", status: "passed", detail: validationCommand });
          } catch (error) {
            replay.validationStatus = "failed";
            findings.push(`validation failed in replay worktree: ${error instanceof Error ? error.message : String(error)}`);
            log.push({ step: "validation", status: "failed", detail: validationCommand });
          }
        }
      }
    }
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
    log.push({ step: "unexpected-error", status: "failed", detail: findings.at(-1) ?? "unknown error" });
  }

  const sourceAfter = sourcePath ? await gitSnapshot(sourcePath) : { head: null, status: null };
  const originalRepoMutated = mutationVerdictFor(sourceBefore, sourceAfter) === "changed";
  if (originalRepoMutated) findings.push("original repo HEAD/status changed during replay audit");
  if (!replay.patchApplied) recommendations.push("Do not trust this handoff until the patch applies cleanly in a disposable replay worktree.");
  if (replay.validationStatus !== "passed") recommendations.push("Do not accept this handoff until declared validation passes after replay apply.");
  if (!decisionForms.acceptedValid || !decisionForms.rejectedValid) recommendations.push("Repair decision forms before operator use.");
  if (findings.length === 0) recommendations.push("Handoff is complete, replayable, auditable, and safe for operator review in a disposable worktree.");

  const result: OperatorHandoffReplayResult = {
    auditId,
    handoffPath: handoffDir,
    status: findings.length === 0 ? "passed" : "failed",
    sourceRepo: {
      path: sourcePath,
      headBefore: sourceBefore.head,
      headAfter: sourceAfter.head,
      statusBefore: sourceBefore.status ?? "",
      statusAfter: sourceAfter.status ?? "",
      originalRepoMutated
    },
    replay,
    decisionForms,
    safety,
    findings,
    recommendations,
    artifacts: { auditReport, auditResult, replayLog }
  };

  await writeFile(auditResult, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(replayLog, `${JSON.stringify({ auditId, entries: log }, null, 2)}\n`, "utf8");
  await writeFile(auditReport, renderOperatorHandoffReplayReport(result), "utf8");
  return result;
}

async function replaySourceFor(handoffDir: string, handoff: JsonObject): Promise<string | null> {
  const evidence = objectValue(handoff.evidence);
  const packetPath = stringValue(evidence?.packetPath);
  const run = packetPath ? await readOptionalJson<JsonObject>(join(packetPath, "run.json")) : null;
  const packetRepo = stringValue(objectValue(run?.repo)?.path);
  if (packetRepo) return resolve(packetRepo);
  const localResults = await readOptionalJson<JsonObject>(join(dirname(handoffDir), "results.json"));
  const disposable = objectValue(localResults?.disposable);
  const sourceRepo = stringValue(disposable?.sourceRepo);
  if (sourceRepo) return resolve(sourceRepo);
  const worktree = stringValue(objectValue(handoff.worktree)?.path);
  return worktree ? resolve(worktree) : null;
}

function resolveHandoffChild(root: string, path: string): string | null {
  const resolved = resolve(root, path);
  return resolved === root || resolved.startsWith(`${root}${sep}`) ? resolved : null;
}

function unsafePatchPaths(patchText: string): string[] {
  const findings: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^(?:diff --git|---|\+\+\+)\s+(?:(?:a|b)\/)?(.+)$/.exec(line);
    if (!match) continue;
    const target = match[1]!;
    if (target.startsWith("/") || target.includes("..")) findings.push(`proposal.patch contains unsafe path: ${target}`);
  }
  return [...new Set(findings)];
}

async function validateAcceptedDecision(path: string, findings: string[]): Promise<boolean> {
  const form = await readOptionalJson<JsonObject>(path);
  const local: string[] = [];
  if (!form) local.push("accepted decision form is missing or invalid JSON");
  else {
    if (form.decision !== "accepted") local.push("accepted decision form missing decision=accepted");
    if (form.originalRepoMutated !== false) local.push("accepted decision form originalRepoMutated must be false");
    if (form.appliedTo === "original_repo" || objectValue(form.apply)?.appliedTo === "original_repo") local.push("accepted decision form must not target original_repo");
    if (form.runforgeAppliedPatch !== false) local.push("accepted decision form runforgeAppliedPatch must be false");
    if (form.afterValidation !== "passed" && objectValue(form.validation)?.passed !== true) local.push("accepted decision form must record passed validation");
  }
  findings.push(...local);
  return local.length === 0;
}

async function validateRejectedDecision(path: string, findings: string[]): Promise<boolean> {
  const form = await readOptionalJson<JsonObject>(path);
  const local: string[] = [];
  if (!form) local.push("rejected decision form is missing or invalid JSON");
  else {
    if (form.decision !== "rejected") local.push("rejected decision form missing decision=rejected");
    if (!stringValue(form.reason)) local.push("rejected decision form requires a reason");
    if (form.originalRepoMutated !== false) local.push("rejected decision form originalRepoMutated must be false");
    if (form.appliedTo === "original_repo" || objectValue(form.apply)?.appliedTo === "original_repo") local.push("rejected decision form must not target original_repo");
    if (form.runforgeAppliedPatch !== false) local.push("rejected decision form runforgeAppliedPatch must be false");
  }
  findings.push(...local);
  return local.length === 0;
}

async function readInstructions(root: string): Promise<string> {
  const chunks = await Promise.all(["README.md", "apply-instructions.md", "validation.md", "rollback.md"].map(async (name) => readFile(join(root, name), "utf8").catch(() => "")));
  return chunks.join("\n");
}

function unsafeInstructionFindings(text: string): string[] {
  const findings: string[] = [];
  if (/\b(?:git\s+push|git\s+merge|(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy|kubectl\s+apply|terraform\s+apply)\b/i.test(text)) findings.push("handoff instructions mention push, merge, deploy, or infrastructure apply commands");
  if (/\b(?:allowedTarget|allowed target)\s*(?:is|:|=)\s*original_repo\b/i.test(text)) findings.push("handoff instructions allow original repo target");
  return findings;
}

function unsafeCommandFindings(command: string): string[] {
  if (!command) return ["validation command is missing"];
  const lower = command.toLowerCase();
  const forbidden = [
    ["push", /\bgit\s+push\b/],
    ["merge", /\bgit\s+merge\b/],
    ["deploy", /\bdeploy\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/],
    ["network", /\b(?:curl|wget|ssh|scp|rsync|nc|telnet)\b|https?:\/\//],
    ["database", /\b(?:psql|mysql|mongosh|mongo|redis-cli)\b/]
  ];
  return forbidden.filter(([, pattern]) => (pattern as RegExp).test(lower)).map(([label]) => `validation command attempts forbidden ${label} operation`);
}

function isUnderTmp(path: string): boolean {
  const resolved = resolve(path);
  return resolved === "/tmp" || resolved.startsWith(`/tmp${sep}`) || resolved.startsWith("/private/tmp/");
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
