import { isAbsolute, relative, resolve } from "node:path";
import type { RunSpec, TaskType } from "../core/types.js";
import { validateCommandSafety } from "./command-safety.js";
import { validateContextPackPatterns } from "./context-pack-files.js";

export const supportedRunSpecSchemaVersion = 1;
export const runSpecTaskTypes: TaskType[] = ["failure-triage", "command-check", "repo-research", "context-pack", "code-proposal"];

export interface RunSpecDocument {
  schemaVersion: number;
  taskType: TaskType;
  runId: string;
  artifactNamespace?: string;
  repoPath?: string;
  outDir?: string;
  goal?: string;
  logPath?: string;
  input?: {
    repoPath?: string;
    command?: string;
    goal?: string;
    logPath?: string;
    include?: string[];
    exclude?: string[];
    allowExternalRepo?: boolean;
    maxBytesPerFile?: number;
    maxTotalFiles?: number;
    maxTotalBytes?: number;
    docsProposal?: {
      targetFile?: string;
      anchorText?: string;
      insertedText?: string;
      rationale?: string;
      evidenceFiles?: string[];
    };
  };
  safety?: {
    repoWritesAllowed?: boolean;
    networkAllowed?: boolean;
    commandExecutionAllowed?: boolean;
    safetyProfile?: RunSpec["safetyProfile"];
    applyMode?: RunSpec["applyMode"];
  };
}

export function normalizeRunSpecDocument(document: unknown, cwd: string): RunSpec {
  const raw = expectRecord(document, "RunSpec must be a JSON object.");
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== supportedRunSpecSchemaVersion) {
    throw new Error(`Unsupported RunSpec schemaVersion: ${String(schemaVersion)}.`);
  }

  const taskType = readTaskType(raw.taskType);
  const runId = readSafePathSegment(raw.runId, "runId");
  const artifactNamespace =
    raw.artifactNamespace === undefined ? undefined : readSafePathSegment(raw.artifactNamespace, "artifactNamespace");
  const input = raw.input === undefined ? {} : expectRecord(raw.input, "RunSpec input must be an object.");
  const safety = raw.safety === undefined ? {} : expectRecord(raw.safety, "RunSpec safety must be an object.");
  const command = readOptionalString(input.command, "input.command");
  const rawRepoPath = readOptionalString(raw.repoPath, "repoPath") ?? readOptionalString(input.repoPath, "input.repoPath") ?? ".";
  const repoPath = resolveStringPath(rawRepoPath, cwd);
  const contextPack = taskType === "context-pack" ? readContextPackInput(input, repoPath) : undefined;
  const allowExternalRepo = taskType === "code-proposal" ? readOptionalBoolean(input.allowExternalRepo, "input.allowExternalRepo") ?? false : undefined;
  if (taskType === "code-proposal") validateExternalRepoOptIn(repoPath, allowExternalRepo ?? false, "code-proposal");
  const docsProposal = taskType === "code-proposal" ? readDocsProposalInput(input, repoPath) : undefined;

  if (taskType === "command-check") {
    if (!command) throw new Error("command-check RunSpec requires input.command.");
    const blocked = validateCommandSafety(command);
    if (blocked) throw new Error(blocked.reason);
  }
  validateSafety(taskType, safety);

  return {
    runId,
    artifactNamespace,
    taskType,
    repoPath,
    goal: readOptionalString(raw.goal, "goal") ?? readOptionalString(input.goal, "input.goal"),
    logPath: resolveOptionalPath(readOptionalString(raw.logPath, "logPath") ?? readOptionalString(input.logPath, "input.logPath"), cwd),
    command,
    allowExternalRepo,
    contextPack,
    docsProposal,
    outDir: resolveStringPath(readOptionalString(raw.outDir, "outDir") ?? "./artifacts/runspec", cwd),
    safetyProfile: readSafetyProfile(safety.safetyProfile, taskType),
    applyMode: readApplyMode(safety.applyMode)
  };
}

function validateSafety(taskType: TaskType, safety: Record<string, unknown>): void {
  if (safety.repoWritesAllowed === true) throw new Error("RunSpec safety.repoWritesAllowed=true is not supported.");
  if (safety.networkAllowed === true) throw new Error("RunSpec safety.networkAllowed=true is not supported.");
  if (taskType === "code-proposal" && safety.repoWritesAllowed !== false) {
    return;
  }
}

function readTaskType(value: unknown): TaskType {
  if (typeof value === "string" && runSpecTaskTypes.includes(value as TaskType)) return value as TaskType;
  throw new Error(`Unknown RunSpec taskType: ${String(value)}.`);
}

function readSafePathSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`RunSpec ${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || isAbsolute(trimmed)) {
    throw new Error(`RunSpec ${field} must be a safe artifact path segment.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error(`RunSpec ${field} contains unsupported characters.`);
  }
  return trimmed;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`RunSpec ${field} must be a string.`);
  return value;
}

function readRequiredString(value: unknown, field: string): string {
  const text = readOptionalString(value, field);
  if (text === undefined || text.length === 0) throw new Error(`RunSpec ${field} must be a non-empty string.`);
  return text;
}

function readContextPackInput(input: Record<string, unknown>, repoPath: string): NonNullable<RunSpec["contextPack"]> {
  const allowExternalRepo = readOptionalBoolean(input.allowExternalRepo, "input.allowExternalRepo") ?? false;
  validateExternalRepoOptIn(repoPath, allowExternalRepo, "context-pack");
  const include = readOptionalStringArray(input.include, "input.include") ?? ["**/*"];
  const exclude = readOptionalStringArray(input.exclude, "input.exclude") ?? [];
  validateContextPackPatterns(include, "include");
  validateContextPackPatterns(exclude, "exclude");
  return {
    allowExternalRepo,
    include,
    exclude,
    maxBytesPerFile: readOptionalPositiveInteger(input.maxBytesPerFile, "input.maxBytesPerFile") ?? 12_000,
    maxTotalFiles: readOptionalPositiveInteger(input.maxTotalFiles, "input.maxTotalFiles") ?? 80,
    maxTotalBytes: readOptionalPositiveInteger(input.maxTotalBytes, "input.maxTotalBytes") ?? 240_000
  };
}

function validateExternalRepoOptIn(repoPath: string, allowExternalRepo: boolean, taskType: string): void {
  const root = resolve(process.cwd());
  const target = resolve(repoPath);
  const rel = relative(root, target);
  if (!allowExternalRepo && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`${taskType} repoPath must resolve inside the current RunForge workspace unless input.allowExternalRepo=true.`);
  }
}

function readDocsProposalInput(input: Record<string, unknown>, repoPath: string): RunSpec["docsProposal"] {
  if (input.docsProposal === undefined) return undefined;
  const allowExternalRepo = readOptionalBoolean(input.allowExternalRepo, "input.allowExternalRepo") ?? false;
  const raw = expectRecord(input.docsProposal, "RunSpec input.docsProposal must be an object.");
  const targetFile = readRequiredString(raw.targetFile, "input.docsProposal.targetFile");
  const anchorText = readRequiredString(raw.anchorText, "input.docsProposal.anchorText");
  const insertedText = readRequiredString(raw.insertedText, "input.docsProposal.insertedText");
  const rationale = readRequiredString(raw.rationale, "input.docsProposal.rationale");
  const evidenceFiles = readOptionalStringArray(raw.evidenceFiles, "input.docsProposal.evidenceFiles") ?? [];
  validateContextPackPatterns([targetFile, ...evidenceFiles], "docsProposal");
  return { allowExternalRepo, targetFile, anchorText, insertedText, rationale, evidenceFiles };
}

function readOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`RunSpec ${field} must be an array of strings.`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`RunSpec ${field} must be a boolean.`);
  return value;
}

function readOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`RunSpec ${field} must be a positive integer.`);
  }
  return value;
}

function readSafetyProfile(value: unknown, taskType: TaskType): RunSpec["safetyProfile"] {
  if (value === undefined) return taskType === "command-check" ? "trusted-local" : "safe-local";
  if (value === "safe-local" || value === "trusted-local") return value;
  throw new Error("RunSpec safety.safetyProfile must be safe-local or trusted-local.");
}

function readApplyMode(value: unknown): RunSpec["applyMode"] {
  if (value === undefined) return undefined;
  if (value === "none" || value === "patch-artifact" || value === "isolated-worktree") return value;
  throw new Error("RunSpec safety.applyMode must be none, patch-artifact, or isolated-worktree.");
}

function resolveStringPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function resolveOptionalPath(path: string | undefined, cwd: string): string | undefined {
  return path === undefined ? undefined : resolveStringPath(path, cwd);
}

function expectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(message);
}
