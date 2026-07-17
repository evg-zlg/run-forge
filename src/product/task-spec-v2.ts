import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { blockedCommandReports } from "../run/external-command-check-helpers.js";
import { loadCodeRepairPlan } from "../run/code-repair.js";
import { defaultArtifactRoot, inspectProject, isPathInside } from "./project-inspection.js";

export const taskSpecSchemaVersion = 2;
const topKeys = ["schemaVersion", "taskId", "task", "target", "execution", "discovery", "runtime", "validation", "authority", "git", "merge", "deploy", "artifacts", "ownerGate", "repair"];

export type TaskExecutionMode = "inspection" | "implementation" | "validation" | "repair";

export type TaskSpecV2 = {
  schemaVersion: 2;
  taskId: string;
  task: { text: string; goal: string; acceptanceCriteria: string[] };
  target: { repository: string; workingDirectory: string; expectedSha: string };
  execution: { mode: TaskExecutionMode; maxRepairIterations: number; timeoutMs: number; maxChangedFiles: number; maxPatchBytes: number; maxProviderTokens: number };
  discovery: { policy: "auto" | "explicit" };
  runtime: { preference: "docker" | "local"; dockerImage: string; dependencyPreparation: "required" | "if-needed" | "disabled" | "reuse-existing"; externalNetwork: "denied" | "dependency-preparation-only" | "allowed" };
  validation: { mode: "auto" | "explicit"; commands: string[] };
  authority: { profile: "read-only" | "bounded-implementation"; envelopeFile: string | null; forbiddenAreas: string[]; allowProviderCalls: boolean; allowNetwork: boolean };
  git: { publication: "none" | "draft-pr"; branch: string | null };
  merge: { policy: "never" };
  deploy: { policy: "never" };
  artifacts: { root: string; resultFormat: "normalized-v1" };
  ownerGate: { policy: "stop-and-report" };
  repair: { mode: "none" | "disposable" | "code"; plan: string | null };
};

export async function loadTaskSpecV2(path: string): Promise<TaskSpecV2> {
  const absolute = resolve(path);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(absolute, "utf8")); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read valid TaskSpec JSON at ${absolute}: ${message}`);
  }
  return normalizeTaskSpecV2(parsed, dirname(absolute));
}

export async function normalizeTaskSpecV2(value: unknown, baseDir = process.cwd()): Promise<TaskSpecV2> {
  const raw = object(value, "TaskSpec must be a JSON object.");
  rejectUnknown(raw, topKeys, "TaskSpec");
  assertNoCredentialLikeValues(raw);
  if (raw.schemaVersion !== taskSpecSchemaVersion) throw new Error(`Unsupported TaskSpec schemaVersion: ${String(raw.schemaVersion)}; supported: 2.`);
  const taskId = string(raw.taskId, "taskId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(taskId)) throw new Error("taskId must be 3-80 characters using letters, numbers, '.', '_' or '-'.");
  const task = object(raw.task, "task must be an object.");
  rejectUnknown(task, ["text", "goal", "acceptanceCriteria"], "task");
  const target = object(raw.target, "target must be an object.");
  rejectUnknown(target, ["repository", "workingDirectory", "expectedSha"], "target");
  const repositoryInput = string(target.repository, "target.repository");
  const repository = resolve(baseDir, repositoryInput);
  const workingDirectory = optionalString(target.workingDirectory, "target.workingDirectory") ?? ".";
  const inspection = await inspectProject(repository, workingDirectory);
  if (!inspection.exists) throw new Error(`target.repository does not exist: ${repository}`);
  if (!inspection.isGitRepository || !inspection.path) throw new Error(`target.repository must be a Git repository: ${repository}`);
  if (!inspection.head) throw new Error(`target.repository must have a valid committed HEAD: ${repository}`);
  const expectedSha = optionalString(target.expectedSha, "target.expectedSha") ?? inspection.head;
  if (expectedSha !== inspection.head) throw new Error(`target.expectedSha mismatch: expected ${expectedSha}, current ${inspection.head}.`);
  const executionRaw = object(raw.execution, "execution is required and must be an object.");
  rejectUnknown(executionRaw, ["mode", "maxRepairIterations", "timeoutMs", "maxChangedFiles", "maxPatchBytes", "maxProviderTokens"], "execution");
  const artifactsRaw = optionalObject(raw.artifacts, "artifacts");
  rejectUnknown(artifactsRaw, ["root", "resultFormat"], "artifacts");
  const artifactInput = optionalString(artifactsRaw.root, "artifacts.root") ?? join(defaultArtifactRoot(inspection.path), taskId);
  const artifactRoot = resolve(baseDir, artifactInput);
  if (await isPathInside(inspection.path, artifactRoot)) throw new Error(`artifacts.root must be outside target.repository: ${artifactRoot}`);
  const validationRaw = optionalObject(raw.validation, "validation");
  rejectUnknown(validationRaw, ["mode", "commands"], "validation");
  const validationMode = choice(validationRaw.mode ?? "auto", ["auto", "explicit"], "validation.mode");
  const explicitCommands = strings(validationRaw.commands ?? [], "validation.commands");
  if (validationMode === "auto" && explicitCommands.length) throw new Error("validation.commands must be empty when validation.mode='auto'.");
  if (validationMode === "explicit" && !explicitCommands.length) throw new Error("validation.mode='explicit' requires validation.commands.");
  const commands = validationMode === "auto" ? inspection.validationCommands : explicitCommands;
  if (!commands.length) throw new Error("No validation commands were discovered; set validation.mode='explicit' and provide commands.");
  const blocked = blockedCommandReports(commands, "main");
  if (blocked[0]) throw new Error(`Unsafe validation command: ${blocked[0].reason}`);
  const discoveryRaw = optionalObject(raw.discovery, "discovery");
  rejectUnknown(discoveryRaw, ["policy"], "discovery");
  const runtimeRaw = optionalObject(raw.runtime, "runtime");
  rejectUnknown(runtimeRaw, ["preference", "dockerImage", "prepareDependencies", "dependencyPreparation", "externalNetwork"], "runtime");
  const authorityRaw = optionalObject(raw.authority, "authority");
  rejectUnknown(authorityRaw, ["profile", "envelopeFile", "forbiddenAreas", "allowProviderCalls", "allowNetwork"], "authority");
  const gitRaw = optionalObject(raw.git, "git");
  rejectUnknown(gitRaw, ["publication", "branch"], "git");
  const mergeRaw = optionalObject(raw.merge, "merge");
  rejectUnknown(mergeRaw, ["policy"], "merge");
  const deployRaw = optionalObject(raw.deploy, "deploy");
  rejectUnknown(deployRaw, ["policy"], "deploy");
  const ownerRaw = optionalObject(raw.ownerGate, "ownerGate");
  rejectUnknown(ownerRaw, ["policy"], "ownerGate");
  const repairRaw = optionalObject(raw.repair, "repair");
  rejectUnknown(repairRaw, ["mode", "plan"], "repair");
  const profile = choice(authorityRaw.profile ?? "read-only", ["read-only", "bounded-implementation"], "authority.profile");
  const forbiddenAreas = strings(authorityRaw.forbiddenAreas ?? defaultForbidden(), "authority.forbiddenAreas");
  const repairMode = choice(repairRaw.mode ?? "none", ["none", "disposable", "code"], "repair.mode");
  const executionMode = choice(executionRaw.mode, ["inspection", "implementation", "validation", "repair"], "execution.mode");
  if (["implementation", "repair"].includes(executionMode) !== (profile === "bounded-implementation")) throw new Error(`execution.mode='${executionMode}' is inconsistent with authority.profile='${profile}'.`);
  const authorityFile = authorityRaw.envelopeFile === undefined || authorityRaw.envelopeFile === null ? null : resolve(baseDir, string(authorityRaw.envelopeFile, "authority.envelopeFile"));
  const repairPlan = repairRaw.plan === undefined || repairRaw.plan === null ? null : resolve(baseDir, string(repairRaw.plan, "repair.plan"));
  if (runtimeRaw.prepareDependencies !== undefined && runtimeRaw.dependencyPreparation !== undefined) throw new Error("Use runtime.dependencyPreparation or legacy runtime.prepareDependencies, not both.");
  const legacyPrepare = runtimeRaw.prepareDependencies === undefined ? undefined : boolean(runtimeRaw.prepareDependencies, "runtime.prepareDependencies");
  const dependencyPreparation = choice(runtimeRaw.dependencyPreparation ?? (legacyPrepare === true ? "required" : legacyPrepare === false ? "disabled" : "if-needed"), ["required", "if-needed", "disabled", "reuse-existing"], "runtime.dependencyPreparation");
  if (profile === "read-only" && repairMode !== "none") throw new Error("authority.profile='read-only' requires repair.mode='none'.");
  if (repairMode === "code" && !repairRaw.plan) throw new Error("repair.mode='code' requires repair.plan.");
  const publication = choice(gitRaw.publication ?? "none", ["none", "draft-pr"], "git.publication");
  if (publication === "none" && gitRaw.branch != null) throw new Error("git.branch is only valid when git.publication='draft-pr'.");
  if (publication === "draft-pr" && profile !== "bounded-implementation") throw new Error("Draft PR publication requires bounded-implementation authority.");
  if (publication === "draft-pr" && repairMode === "none") throw new Error("Draft PR publication requires a bounded repair task.");
  if (publication === "draft-pr" && (!gitRaw.branch || !authorityRaw.envelopeFile)) throw new Error("Draft PR publication requires git.branch and authority.envelopeFile.");
  if (authorityFile) await assertRegularFile(authorityFile, "authority.envelopeFile");
  if (repairPlan) await assertRegularFile(repairPlan, "repair.plan");
  const repairFiles = repairMode === "code" && repairPlan ? (await loadCodeRepairPlan(repairPlan)).allowed_files : repairMode === "disposable" ? ["README.md"] : [];
  assertRepairOutsideForbiddenAreas(repairFiles, forbiddenAreas);
  const allowProviderCalls = authorityRaw.allowProviderCalls === undefined ? false : boolean(authorityRaw.allowProviderCalls, "authority.allowProviderCalls");
  const allowNetwork = authorityRaw.allowNetwork === undefined ? false : boolean(authorityRaw.allowNetwork, "authority.allowNetwork");
  const externalNetwork = choice(runtimeRaw.externalNetwork ?? "denied", ["denied", "dependency-preparation-only", "allowed"], "runtime.externalNetwork");
  if (externalNetwork === "allowed" && !allowNetwork) throw new Error("runtime.externalNetwork='allowed' requires authority.allowNetwork=true.");
  const spec: TaskSpecV2 = {
    schemaVersion: 2,
    taskId,
    task: { text: string(task.text, "task.text"), goal: string(task.goal, "task.goal"), acceptanceCriteria: strings(task.acceptanceCriteria, "task.acceptanceCriteria", true) },
    target: { repository: await realpath(inspection.path), workingDirectory: inspection.workingDirectory ?? ".", expectedSha },
    execution: { mode: executionMode, maxRepairIterations: integer(executionRaw.maxRepairIterations, "execution.maxRepairIterations", 0, 3, 2), timeoutMs: integer(executionRaw.timeoutMs, "execution.timeoutMs", 1_000, 1_800_000, 300_000), maxChangedFiles: integer(executionRaw.maxChangedFiles, "execution.maxChangedFiles", 1, 100, 20), maxPatchBytes: integer(executionRaw.maxPatchBytes, "execution.maxPatchBytes", 1_000, 5_000_000, 500_000), maxProviderTokens: integer(executionRaw.maxProviderTokens, "execution.maxProviderTokens", 1_000, 200_000, 100_000) },
    discovery: { policy: choice(discoveryRaw.policy ?? "auto", ["auto", "explicit"], "discovery.policy") },
    runtime: {
      preference: choice(runtimeRaw.preference ?? "docker", ["docker", "local"], "runtime.preference"),
      dockerImage: optionalString(runtimeRaw.dockerImage, "runtime.dockerImage") ?? "runforge:local",
      dependencyPreparation,
      externalNetwork
    },
    validation: { mode: validationMode, commands },
    authority: { profile, envelopeFile: authorityFile, forbiddenAreas, allowProviderCalls, allowNetwork },
    git: { publication, branch: nullableString(gitRaw.branch, "git.branch") },
    merge: { policy: choice(mergeRaw.policy ?? "never", ["never"], "merge.policy") },
    deploy: { policy: choice(deployRaw.policy ?? "never", ["never"], "deploy.policy") },
    artifacts: { root: artifactRoot, resultFormat: choice(artifactsRaw.resultFormat ?? "normalized-v1", ["normalized-v1"], "artifacts.resultFormat") },
    ownerGate: { policy: choice(ownerRaw.policy ?? "stop-and-report", ["stop-and-report"], "ownerGate.policy") },
    repair: { mode: repairMode, plan: repairPlan }
  };
  await assertArtifactRootSafe(artifactRoot, spec);
  return spec;
}

export function redactedTaskSpec(spec: TaskSpecV2): TaskSpecV2 {
  return redactValue(spec) as TaskSpecV2;
}

function object(value: unknown, message: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message); return value as Record<string, unknown>; }
function optionalObject(value: unknown, name: string): Record<string, unknown> { return value === undefined ? {} : object(value, `${name} must be an object.`); }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { return value === undefined ? undefined : string(value, name); }
function nullableString(value: unknown, name: string): string | null { return value === undefined || value === null ? null : string(value, name); }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`); return value; }
function integer(value: unknown, name: string, min: number, max: number, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || Number(parsed) < min || Number(parsed) > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`); return Number(parsed); }
function strings(value: unknown, name: string, nonEmpty = false): string[] { if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be ${nonEmpty ? "a non-empty " : "an "}array of non-empty strings.`); return value.map((item) => item.trim()); }
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T { if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}.`); return value as T; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`${name} contains unknown field(s): ${unknown.join(", ")}.`); }
function defaultForbidden(): string[] { return ["target main mutation or push", "PR merge", "deploy", "database", "production", "secrets", "migrations"]; }

function assertRepairOutsideForbiddenAreas(files: string[], areas: string[]): void {
  const paths = areas.filter((area) => !/\s/.test(area)).map((area) => area.replace(/^\.\//, "").replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\/$/, ""));
  for (const file of files) {
    const forbidden = paths.find((path) => path && (file === path || file.startsWith(`${path}/`) || file.split("/").includes(path)));
    if (forbidden) throw new Error(`Repair file is forbidden by authority.forbiddenAreas: ${file} (${forbidden}).`);
  }
}

async function assertArtifactRootSafe(path: string, spec: TaskSpecV2): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`artifacts.root already exists and is not a directory: ${path}`);
  const existing = await readFile(join(path, "task-spec.normalized.json"), "utf8").then((text) => JSON.parse(text) as unknown, () => null);
  if (JSON.stringify(existing) !== JSON.stringify(redactedTaskSpec(spec))) {
    throw new Error(`Refusing to replace existing artifacts.root without an identical normalized TaskSpec: ${path}`);
  }
}

async function assertRegularFile(path: string, field: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`${field} must point to an existing file: ${path}`);
}

const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:ghp_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*["']?[^\s"',;]{4,}/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/i
];

function assertNoCredentialLikeValues(value: unknown, path = "TaskSpec"): void {
  if (typeof value === "string" && credentialPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${path} contains credential-like material; remove secrets before submitting TaskSpec.`);
  }
  if (Array.isArray(value)) value.forEach((item, index) => assertNoCredentialLikeValues(item, `${path}[${index}]`));
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) assertNoCredentialLikeValues(item, `${path}.${key}`);
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return credentialPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:password|passwd|secret|credential|api[_-]?key|access[_-]?token|auth[_-]?token)$/i.test(key) ? "[REDACTED]" : redactValue(item)]));
  }
  return value;
}
