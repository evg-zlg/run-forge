import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { blockedCommandReports } from "../run/external-command-check-helpers.js";
import { loadCodeRepairPlan } from "../run/code-repair.js";
import { EXECUTION_PARTIES, EXECUTION_PHASE_IDS, EXECUTION_PROFILES, type ExecutionParty, type ExecutionPhaseId, type ExecutionProfile } from "./execution-agreement.js";
import { defaultArtifactRoot, inspectProject, isPathInside } from "./project-inspection.js";
import { assertNoCredentialLikeKey, normalizeProviderRouting, type ProviderRouting } from "./provider-routing.js";
import { defaultRuntimeForMode, implementationExecutorContract, runtimeCompatibleWithImplementationExecutor, taskExecutionModes, taskRuntimeIds, taskSpecSchemaVersion, type TaskExecutionMode, type TaskRuntimeId } from "./task-spec-contract.js";
import {
  VALIDATION_ACCEPTANCE, VALIDATION_CAPABILITIES, defaultValidationProfile, normalizeValidationRequirements,
  type ValidationCommandRequirement, type ValidationProfile, type ValidationProjectPolicy,
} from "../validation/capability-contract.js";

export { taskSpecSchemaVersion } from "./task-spec-contract.js";
const topKeys = ["schemaVersion", "taskId", "task", "target", "execution", "providerRouting", "executionAgreement", "discovery", "runtime", "validation", "authority", "git", "merge", "deploy", "artifacts", "ownerGate", "repair"];

export type { TaskExecutionMode } from "./task-spec-contract.js";

export type TaskSpecExecutionAgreement =
  | { schemaVersion: 1; profile: Exclude<ExecutionProfile, "custom">; phaseOwnership?: never }
  | {
    schemaVersion: 1;
    profile: "custom";
    /** Omitted phases are not requested. */
    phaseOwnership: Partial<Record<ExecutionPhaseId, ExecutionParty>>;
  };

export type TaskSpecV2 = {
  schemaVersion: 2;
  taskId: string;
  task: { text: string; goal: string; acceptanceCriteria: string[] };
  target: { repository: string; workingDirectory: string; expectedSha: string; dirtyPolicy?: "require_clean" | "allow_known_generated" | "snapshot_from_sha" | "use_disposable_from_base_sha" };
  execution: { mode: TaskExecutionMode; maxRepairIterations: number; timeoutMs: number; maxChangedFiles: number; maxPatchBytes: number; maxProviderTokens: number; budgetMode: "soft" | "hard"; phaseBudgets: Record<"startup" | "analysis" | "implementation" | "validation" | "repair" | "review" | "publication", number>; maxInputContextTokens?: number; maxOutputTokens?: number; maxReasoningTokens?: number; reasoningSetting?: string; maxCallsPerPhase?: number; maxPhaseTokens?: number; maxTaskTokens?: number; earlyProgressDeadlineMs?: number; maxCostUsd?: number; requestedProfile?: "fast" | "standard" | "heavy" };
  providerRouting: ProviderRouting;
  executionAgreement: TaskSpecExecutionAgreement;
  discovery: { policy: "auto" | "explicit"; profile: "small-scope" | "standard"; explicitFiles: string[]; /** Present only when a campaign has an explicit write boundary. */ writeScopes?: string[]; maxFiles: number; maxBytes: number; maxTokens: number; stopCondition: string };
  runtime: { preference: TaskRuntimeId; dockerImage: string; dependencyPreparation: "required" | "if-needed" | "disabled" | "reuse-existing"; externalNetwork: "denied" | "dependency-preparation-only" | "allowed" };
  validation: {
    mode: "auto" | "explicit"; commands: string[]; requirements: ValidationCommandRequirement[];
    profile: ValidationProfile; projectPolicy: ValidationProjectPolicy;
  };
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
  rejectUnknown(target, ["repository", "workingDirectory", "expectedSha", "dirtyPolicy"], "target");
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
  rejectUnknown(executionRaw, ["mode", "maxRepairIterations", "timeoutMs", "maxChangedFiles", "maxPatchBytes", "maxProviderTokens", "budgetMode", "phaseBudgets", "maxInputContextTokens", "maxOutputTokens", "maxReasoningTokens", "reasoningSetting", "maxCallsPerPhase", "maxPhaseTokens", "maxTaskTokens", "earlyProgressDeadlineMs", "maxCostUsd", "requestedProfile"], "execution");
  const artifactsRaw = optionalObject(raw.artifacts, "artifacts");
  rejectUnknown(artifactsRaw, ["root", "resultFormat"], "artifacts");
  const artifactInput = optionalString(artifactsRaw.root, "artifacts.root") ?? join(defaultArtifactRoot(inspection.path), taskId);
  const artifactRoot = resolve(baseDir, artifactInput);
  if (await isPathInside(inspection.path, artifactRoot)) throw new Error(`artifacts.root must be outside target.repository: ${artifactRoot}`);
  const validationRaw = optionalObject(raw.validation, "validation");
  rejectUnknown(validationRaw, ["mode", "commands", "requirements", "profile", "projectPolicy"], "validation");
  const validationMode = choice(validationRaw.mode ?? "auto", ["auto", "explicit"], "validation.mode");
  const explicitCommands = strings(validationRaw.commands ?? [], "validation.commands");
  if (validationMode === "auto" && explicitCommands.length) throw new Error("validation.commands must be empty when validation.mode='auto'.");
  if (validationMode === "explicit" && !explicitCommands.length) throw new Error("validation.mode='explicit' requires validation.commands.");
  const commands = validationMode === "auto" ? inspection.validationCommands : explicitCommands;
  if (!commands.length) throw new Error("No validation commands were discovered; set validation.mode='explicit' and provide commands.");
  // Git validation is never executed as a shell command. Its dedicated lane performs stricter
  // structural parsing and records unsupported forms as capability_unsupported before spawn.
  const blocked = blockedCommandReports(commands.filter((command) => !/^git(?:\s|$)/.test(command.trim())), "main");
  if (blocked[0]) throw new Error(`Unsafe validation command: ${blocked[0].reason}`);
  const requirementInputs = array(validationRaw.requirements).map((value, index) => {
    const item = object(value, `validation.requirements[${index}] must be an object.`);
    rejectUnknown(item, ["command", "capabilities", "acceptance", "evidenceRole", "fallbacks"], `validation.requirements[${index}]`);
    return {
      command: string(item.command, `validation.requirements[${index}].command`),
      capabilities: choices(item.capabilities ?? [], VALIDATION_CAPABILITIES, `validation.requirements[${index}].capabilities`),
      acceptance: item.acceptance === undefined ? undefined : choice(item.acceptance, VALIDATION_ACCEPTANCE, `validation.requirements[${index}].acceptance`),
      evidenceRole: optionalString(item.evidenceRole, `validation.requirements[${index}].evidenceRole`),
      fallbacks: strings(item.fallbacks ?? [], `validation.requirements[${index}].fallbacks`),
    };
  });
  const profileRaw = optionalObject(validationRaw.profile, "validation.profile");
  rejectUnknown(profileRaw, ["id", "defaultAcceptance", "defaultEvidenceRole", "additionalCapabilities"], "validation.profile");
  const defaultProfile = defaultValidationProfile(validationMode);
  const normalizedValidation = normalizeValidationRequirements({
    commands, mode: validationMode, requirements: requirementInputs,
    profile: {
      id: optionalString(profileRaw.id, "validation.profile.id") ?? defaultProfile.id,
      defaultAcceptance: choice(profileRaw.defaultAcceptance ?? defaultProfile.defaultAcceptance, VALIDATION_ACCEPTANCE, "validation.profile.defaultAcceptance"),
      defaultEvidenceRole: optionalString(profileRaw.defaultEvidenceRole, "validation.profile.defaultEvidenceRole") ?? defaultProfile.defaultEvidenceRole,
      additionalCapabilities: choices(profileRaw.additionalCapabilities ?? [], VALIDATION_CAPABILITIES, "validation.profile.additionalCapabilities"),
    },
  });
  const policyRaw = optionalObject(validationRaw.projectPolicy, "validation.projectPolicy");
  rejectUnknown(policyRaw, ["deniedCapabilities", "skippedCommands"], "validation.projectPolicy");
  const discoveryRaw = optionalObject(raw.discovery, "discovery");
  rejectUnknown(discoveryRaw, ["policy", "profile", "explicitFiles", "writeScopes", "maxFiles", "maxBytes", "maxTokens", "stopCondition"], "discovery");
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
  const executionMode = choice(executionRaw.mode, taskExecutionModes, "execution.mode");
  const execution = normalizeExecution(executionRaw, executionMode);
  const providerRouting = normalizeProviderRouting(raw.providerRouting, execution);
  const executionAgreement = normalizeExecutionAgreementRequest(raw.executionAgreement, executionMode);
  if (["implementation", "repair"].includes(executionMode) !== (profile === "bounded-implementation")) throw new Error(`execution.mode='${executionMode}' is inconsistent with authority.profile='${profile}'.`);
  const authorityFile = authorityRaw.envelopeFile === undefined || authorityRaw.envelopeFile === null ? null : resolve(baseDir, string(authorityRaw.envelopeFile, "authority.envelopeFile"));
  const repairPlan = repairRaw.plan === undefined || repairRaw.plan === null ? null : resolve(baseDir, string(repairRaw.plan, "repair.plan"));
  if (runtimeRaw.prepareDependencies !== undefined && runtimeRaw.dependencyPreparation !== undefined) throw new Error("Use runtime.dependencyPreparation or legacy runtime.prepareDependencies, not both.");
  const legacyPrepare = runtimeRaw.prepareDependencies === undefined ? undefined : boolean(runtimeRaw.prepareDependencies, "runtime.prepareDependencies");
  const dependencyPreparation = choice(runtimeRaw.dependencyPreparation ?? (legacyPrepare === true ? "required" : legacyPrepare === false ? "disabled" : "if-needed"), ["required", "if-needed", "disabled", "reuse-existing"], "runtime.dependencyPreparation");
  const runtimePreference = choice(runtimeRaw.preference ?? defaultRuntimeForMode(executionMode), taskRuntimeIds, "runtime.preference");
  if (implementationExecutorContract.modes.includes(executionMode as "implementation" | "repair") && !runtimeCompatibleWithImplementationExecutor(runtimePreference)) {
    throw new Error(`runtime.preference='${runtimePreference}' is incompatible with ${implementationExecutorContract.id}; supported: ${implementationExecutorContract.runtimes.join(", ")}.`);
  }
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
  const discovery = normalizeDiscovery(discoveryRaw);
  const spec: TaskSpecV2 = {
    schemaVersion: 2,
    taskId,
    task: { text: string(task.text, "task.text"), goal: string(task.goal, "task.goal"), acceptanceCriteria: strings(task.acceptanceCriteria, "task.acceptanceCriteria", true) },
    target: { repository: await realpath(inspection.path), workingDirectory: inspection.workingDirectory ?? ".", expectedSha, ...(target.dirtyPolicy !== undefined || executionMode === "implementation" ? { dirtyPolicy: choice(target.dirtyPolicy ?? "use_disposable_from_base_sha", ["require_clean", "allow_known_generated", "snapshot_from_sha", "use_disposable_from_base_sha"] as const, "target.dirtyPolicy") } : {}) },
    execution,
    providerRouting,
    executionAgreement,
    discovery: normalizeDiscovery(discoveryRaw),
    runtime: {
      preference: runtimePreference,
      dockerImage: optionalString(runtimeRaw.dockerImage, "runtime.dockerImage") ?? "runforge:local",
      dependencyPreparation,
      externalNetwork
    },
    validation: {
      mode: validationMode, commands, requirements: normalizedValidation.requirements, profile: normalizedValidation.profile,
      projectPolicy: {
        deniedCapabilities: choices(policyRaw.deniedCapabilities ?? [], VALIDATION_CAPABILITIES, "validation.projectPolicy.deniedCapabilities"),
        skippedCommands: strings(policyRaw.skippedCommands ?? [], "validation.projectPolicy.skippedCommands"),
      },
    },
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

const budgetPhases = ["startup", "analysis", "implementation", "validation", "repair", "review", "publication"] as const;
function normalizeExecution(raw: Record<string, unknown>, mode: TaskExecutionMode): TaskSpecV2["execution"] {
  const total = integer(raw.maxProviderTokens ?? raw.maxTaskTokens, "execution.maxProviderTokens", 1_000, 200_000, 100_000);
  const phaseRaw = optionalObject(raw.phaseBudgets, "execution.phaseBudgets"); rejectUnknown(phaseRaw, [...budgetPhases], "execution.phaseBudgets");
  const defaults = { startup: .05, analysis: .1, implementation: .45, validation: .1, repair: .2, review: .07, publication: .03 };
  const phaseBudgets = Object.fromEntries(budgetPhases.map((phase) => [phase, integer(phaseRaw[phase], `execution.phaseBudgets.${phase}`, 0, 200_000, Math.floor(total * defaults[phase]))])) as TaskSpecV2["execution"]["phaseBudgets"];
  const maxCallsPerPhase = optionalInteger(raw.maxCallsPerPhase, "execution.maxCallsPerPhase");
  const maxPhaseTokens = optionalInteger(raw.maxPhaseTokens, "execution.maxPhaseTokens");
  const maxTaskTokens = optionalInteger(raw.maxTaskTokens, "execution.maxTaskTokens");
  if (maxTaskTokens !== undefined && maxTaskTokens !== total) throw new Error("execution.maxTaskTokens must match execution.maxProviderTokens when both are provided.");
  if (maxPhaseTokens !== undefined && maxPhaseTokens > total) throw new Error("execution.maxPhaseTokens must not exceed execution.maxProviderTokens.");
  if (maxCallsPerPhase !== undefined && (maxCallsPerPhase < 1 || maxCallsPerPhase > 32)) throw new Error("execution.maxCallsPerPhase must be an integer from 1 to 32.");
  const requestedProfile = choice(raw.requestedProfile ?? "standard", ["fast", "standard", "heavy"], "execution.requestedProfile") as "fast" | "standard" | "heavy";
  return { mode, maxRepairIterations: integer(raw.maxRepairIterations, "execution.maxRepairIterations", 0, 3, 2), timeoutMs: integer(raw.timeoutMs, "execution.timeoutMs", 1_000, implementationExecutorContract.maxLimits.timeoutMs, 300_000), maxChangedFiles: integer(raw.maxChangedFiles, "execution.maxChangedFiles", 1, 100, 20), maxPatchBytes: integer(raw.maxPatchBytes, "execution.maxPatchBytes", 1_000, 5_000_000, 500_000), maxProviderTokens: total, budgetMode: choice(raw.budgetMode ?? "soft", ["soft", "hard"], "execution.budgetMode"), phaseBudgets, ...(optionalInteger(raw.maxInputContextTokens, "execution.maxInputContextTokens") !== undefined ? { maxInputContextTokens: optionalInteger(raw.maxInputContextTokens, "execution.maxInputContextTokens") ?? undefined } : {}), ...(optionalInteger(raw.maxOutputTokens, "execution.maxOutputTokens") !== undefined ? { maxOutputTokens: optionalInteger(raw.maxOutputTokens, "execution.maxOutputTokens") ?? undefined } : {}), ...(optionalInteger(raw.maxReasoningTokens, "execution.maxReasoningTokens") !== undefined ? { maxReasoningTokens: optionalInteger(raw.maxReasoningTokens, "execution.maxReasoningTokens") ?? undefined } : {}), ...(optionalString(raw.reasoningSetting, "execution.reasoningSetting") !== undefined ? { reasoningSetting: optionalString(raw.reasoningSetting, "execution.reasoningSetting") } : {}), ...(maxCallsPerPhase !== undefined ? { maxCallsPerPhase } : {}), ...(maxPhaseTokens !== undefined ? { maxPhaseTokens } : {}), ...(maxTaskTokens !== undefined ? { maxTaskTokens } : {}), ...(optionalInteger(raw.earlyProgressDeadlineMs, "execution.earlyProgressDeadlineMs") !== undefined ? { earlyProgressDeadlineMs: optionalInteger(raw.earlyProgressDeadlineMs, "execution.earlyProgressDeadlineMs") ?? undefined } : {}), ...(optionalPositiveNumber(raw.maxCostUsd, "execution.maxCostUsd") !== undefined ? { maxCostUsd: optionalPositiveNumber(raw.maxCostUsd, "execution.maxCostUsd") } : {}), requestedProfile };
}
function normalizeDiscovery(raw: Record<string, unknown>): TaskSpecV2["discovery"] {
  const profile = choice(raw.profile ?? "standard", ["small-scope", "standard"], "discovery.profile");
  const writeScopes = raw.writeScopes === undefined ? undefined : strings(raw.writeScopes, "discovery.writeScopes");
  if (writeScopes?.some((scope) => !safeWriteScope(scope))) throw new Error("discovery.writeScopes must contain safe relative paths.");
  return { policy: choice(raw.policy ?? "auto", ["auto", "explicit"], "discovery.policy"), profile, explicitFiles: strings(raw.explicitFiles ?? [], "discovery.explicitFiles"), ...(writeScopes === undefined ? {} : { writeScopes: [...new Set(writeScopes)] }), maxFiles: integer(raw.maxFiles, "discovery.maxFiles", 1, 1_000, profile === "small-scope" ? 20 : 100), maxBytes: integer(raw.maxBytes, "discovery.maxBytes", 1_000, 10_000_000, profile === "small-scope" ? 240_000 : 1_000_000), maxTokens: integer(raw.maxTokens, "discovery.maxTokens", 100, 500_000, profile === "small-scope" ? 30_000 : 100_000), stopCondition: optionalString(raw.stopCondition, "discovery.stopCondition") ?? "Stop when the task, declared files, directly related tests/config, and minimum mandatory policy are sufficient." };
}

export function redactedTaskSpec(spec: TaskSpecV2): TaskSpecV2 {
  return redactValue(spec) as TaskSpecV2;
}

function object(value: unknown, message: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message); return value as Record<string, unknown>; }
function optionalObject(value: unknown, name: string): Record<string, unknown> { return value === undefined ? {} : object(value, `${name} must be an object.`); }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value.trim(); }
function optionalString(value: unknown, name: string): string | undefined { return value === undefined ? undefined : string(value, name); }
function nullableString(value: unknown, name: string): string | null { return value === undefined || value === null ? null : string(value, name); }
function optionalInteger(value: unknown, name: string): number | undefined { return value === undefined ? undefined : integer(value, name, 0, 200_000, 0); }
function optionalPositiveNumber(value: unknown, name: string): number | undefined { return value === undefined ? undefined : cappedNumber(value, name, 1_000, 1); }
function boolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`); return value; }
function integer(value: unknown, name: string, min: number, max: number, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || Number(parsed) < min || Number(parsed) > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`); return Number(parsed); }
function cappedInteger(value: unknown, name: string, min: number, max: number, fallback: number): number { const parsed = value === undefined ? fallback : value; if (!Number.isInteger(parsed) || Number(parsed) < min) throw new Error(`${name} must be an integer of at least ${min}.`); return Math.min(Number(parsed), max); }
function cappedNumber(value: unknown, name: string, max: number, fallback: number): number { const parsed = value === undefined ? fallback : value; if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive finite number.`); return Math.min(parsed, max); }
function strings(value: unknown, name: string, nonEmpty = false): string[] { if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be ${nonEmpty ? "a non-empty " : "an "}array of non-empty strings.`); return value.map((item) => item.trim()); }
function safeWriteScope(value: string): boolean { const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""); return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..") && !normalized.split("/").includes(".git"); }
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T { if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}.`); return value as T; }
function choices<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] { return strings(value, name).map((item) => choice(item, allowed, name)); }
function array(value: unknown): unknown[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error("validation.requirements must be an array."); return value; }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`${name} contains unknown field(s): ${unknown.join(", ")}.`); }
function defaultForbidden(): string[] { return ["target main mutation or push", "PR merge", "deploy", "database", "production", "secrets", "migrations"]; }

function normalizeExecutionAgreementRequest(value: unknown, mode: TaskExecutionMode): TaskSpecExecutionAgreement {
  if (value === undefined) {
    return { schemaVersion: 1, profile: mode === "implementation" || mode === "repair" ? "local-ready" : "assist-only" };
  }
  const raw = object(value, "executionAgreement must be an object.");
  rejectUnknown(raw, ["schemaVersion", "profile", "phaseOwnership"], "executionAgreement");
  if (raw.schemaVersion !== 1) throw new Error(`Unsupported executionAgreement.schemaVersion: ${String(raw.schemaVersion)}; supported: 1.`);
  const profile = choice(raw.profile, EXECUTION_PROFILES, "executionAgreement.profile");
  if (profile !== "custom") {
    if (raw.phaseOwnership !== undefined) throw new Error("executionAgreement.phaseOwnership is only valid when profile='custom'.");
    return { schemaVersion: 1, profile };
  }
  const ownershipRaw = object(raw.phaseOwnership, "executionAgreement.profile='custom' requires a non-empty phaseOwnership object.");
  if (Object.keys(ownershipRaw).length === 0) throw new Error("executionAgreement.profile='custom' requires a non-empty phaseOwnership object.");
  const unknownPhases = Object.keys(ownershipRaw).filter((phase) => !(EXECUTION_PHASE_IDS as readonly string[]).includes(phase));
  if (unknownPhases.length) throw new Error(`executionAgreement.phaseOwnership contains unknown phase(s): ${unknownPhases.join(", ")}.`);
  const phaseOwnership: NonNullable<TaskSpecExecutionAgreement["phaseOwnership"]> = {};
  for (const phase of EXECUTION_PHASE_IDS) {
    if (ownershipRaw[phase] !== undefined) phaseOwnership[phase] = choice(ownershipRaw[phase], EXECUTION_PARTIES, `executionAgreement.phaseOwnership.${phase}`);
  }
  return { schemaVersion: 1, profile, phaseOwnership };
}

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
    for (const [key, item] of Object.entries(value)) {
      assertNoCredentialLikeKey(key, path);
      assertNoCredentialLikeValues(item, `${path}.${key}`);
    }
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
