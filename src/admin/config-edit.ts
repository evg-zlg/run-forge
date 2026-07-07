import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { backupAdminConfig, loadAdminConfig, writeAdminConfig, type AdminConfig, type AdminProviderConfig } from "./config.js";
import { draftStatus, type AdminDraftStatus } from "./config-status.js";
import { redactJson, redactSecrets, redactedRef } from "./redaction.js";

export interface AdminConfigDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface AdminConfigValidationResult {
  ok: boolean;
  diagnostics: AdminConfigDiagnostic[];
  normalized: AdminConfig;
}

export interface AdminConfigDiff {
  summary: string[];
  json: string;
}

export interface AdminConfigSaveResult {
  saved: boolean;
  configPath: string;
  backupPath: string | null;
  diagnostics: AdminConfigDiagnostic[];
}

export async function validateAdminConfigDraft(draft: unknown, repoRoot = process.cwd()): Promise<AdminConfigValidationResult> {
  const normalized = normalizeDraft(draft);
  const diagnostics: AdminConfigDiagnostic[] = [];

  if (normalized.schemaVersion !== "admin-alpha") {
    diagnostics.push({ level: "error", code: "unsupported_schema_version", message: "Only schemaVersion admin-alpha is supported.", path: "schemaVersion" });
  }

  const repoIds = new Map<string, number>();
  const repoPaths = new Map<string, number>();
  for (const [index, repo] of normalized.repositories.entries()) {
    const base = `repositories.${index}`;
    validateId(repo.id, diagnostics, `${base}.id`, "repository");
    if (!repo.name.trim()) diagnostics.push({ level: "warning", code: "repository_name_defaulted", message: `Repository ${repo.id || index} has an empty name and will display by id.`, path: `${base}.name` });
    if (!repo.path.trim()) diagnostics.push({ level: "error", code: "repository_path_required", message: "Repository path is required.", path: `${base}.path` });
    count(repoIds, repo.id);
    if (repo.path.trim()) count(repoPaths, resolve(repo.path));
    if (!Array.isArray(repo.tags) || repo.tags.some((tag) => typeof tag !== "string")) {
      diagnostics.push({ level: "error", code: "repository_tags_invalid", message: "Repository tags must be a string list.", path: `${base}.tags` });
    }
    if (repo.path.trim()) {
      const exists = await pathExists(resolve(repo.path));
      diagnostics.push({
        level: exists ? "info" : "warning",
        code: exists ? "repository_path_exists" : "repository_path_missing",
        message: `${repo.id || "Repository"} path ${exists ? "exists" : "does not exist"}: ${resolve(repo.path)}`,
        path: `${base}.path`
      });
    }
  }
  duplicateDiagnostics(repoIds, "duplicate_repository_id", "Duplicate repository id", "repositories", diagnostics);
  duplicateDiagnostics(repoPaths, "duplicate_repository_path", "Duplicate repository path", "repositories", diagnostics, "warning");

  const providerIds = new Map<string, number>();
  for (const [index, provider] of normalized.providers.entries()) {
    const base = `providers.${index}`;
    validateId(provider.id, diagnostics, `${base}.id`, "provider");
    count(providerIds, provider.id);
    if (!provider.type.trim()) diagnostics.push({ level: "error", code: "provider_type_required", message: "Provider type is required.", path: `${base}.type` });
    if (!["openrouter", "cli", "future"].includes(provider.type)) {
      diagnostics.push({ level: "warning", code: "provider_type_unknown", message: `Provider ${provider.id || index} uses unknown type ${provider.type}; it is preserved but not editable in simple mode.`, path: `${base}.type` });
    }
    if (provider.type === "openrouter") validateOpenRouterProvider(provider, diagnostics, base);
    if (provider.type === "cli" && provider.enabled && !provider.command?.trim()) {
      diagnostics.push({ level: "warning", code: "cli_command_missing", message: `Enabled CLI provider ${provider.id || index} has no command configured.`, path: `${base}.command` });
    }
  }
  duplicateDiagnostics(providerIds, "duplicate_provider_id", "Duplicate provider id", "providers", diagnostics);

  const roots = new Map<string, number>();
  for (const [index, root] of normalized.runs.defaultRoots.entries()) {
    const path = `runs.defaultRoots.${index}`;
    if (!root.trim()) diagnostics.push({ level: "error", code: "run_root_empty", message: "Run root must be a non-empty string.", path });
    count(roots, resolve(repoRoot, root));
    if (root.trim()) {
      const absoluteRoot = resolve(repoRoot, root);
      const exists = await pathExists(absoluteRoot);
      diagnostics.push({
        level: exists ? "info" : "warning",
        code: exists ? "run_root_exists" : "run_root_missing",
        message: `Run root ${exists ? "exists" : "does not exist"}: ${absoluteRoot}`,
        path
      });
    }
  }
  duplicateDiagnostics(roots, "duplicate_run_root", "Duplicate run root", "runs.defaultRoots", diagnostics, "warning");

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.level !== "error"),
    diagnostics,
    normalized
  };
}

export function diffAdminConfigs(current: AdminConfig, draft: AdminConfig): AdminConfigDiff {
  const summary = [
    ...diffCollection("Repository", current.repositories, draft.repositories, (item) => summarizeValue(item)),
    ...diffCollection("Provider", current.providers, draft.providers, (item) => summarizeValue(redactProvider(item))),
    ...diffRunRoots(current.runs.defaultRoots, draft.runs.defaultRoots)
  ];
  if (current.schemaVersion !== draft.schemaVersion) summary.unshift(`Schema version changed: ${current.schemaVersion} -> ${draft.schemaVersion}`);
  return {
    summary: summary.length ? summary : ["No changes."],
    json: redactSecrets(JSON.stringify({
      before: redactJson(current),
      after: redactJson(draft)
    }, null, 2))
  };
}

export async function saveAdminConfigDraft(options: { configPath: string; draft: unknown; repoRoot?: string; backup?: boolean }): Promise<AdminConfigSaveResult> {
  const validation = await validateAdminConfigDraft(options.draft, options.repoRoot);
  if (!validation.ok) {
    return {
      saved: false,
      configPath: resolve(options.configPath),
      backupPath: null,
      diagnostics: validation.diagnostics
    };
  }
  const configPath = resolve(options.configPath);
  const backupPath = options.backup === false ? null : await backupAdminConfig(configPath);
  await writeAdminConfig(configPath, validation.normalized);
  return {
    saved: true,
    configPath,
    backupPath,
    diagnostics: validation.diagnostics
  };
}

export async function loadConfigEditorPayload(configPath?: string, repoRoot = process.cwd()): Promise<{
  configPath: string;
  exists: boolean;
  config: AdminConfig;
  diagnostics: AdminConfigDiagnostic[];
  status: AdminDraftStatus;
}> {
  const loaded = await loadAdminConfig(configPath);
  const validation = await validateAdminConfigDraft(loaded.config, repoRoot);
  return {
    configPath: loaded.path,
    exists: loaded.exists,
    config: redactJson(validation.normalized),
    diagnostics: validation.diagnostics,
    status: await draftStatus(validation.normalized, repoRoot)
  };
}

function normalizeDraft(value: unknown): AdminConfig {
  const input = isRecord(value) ? value : {};
  return {
    schemaVersion: input.schemaVersion === "admin-alpha" ? "admin-alpha" : String(input.schemaVersion ?? "admin-alpha"),
    repositories: Array.isArray(input.repositories) ? input.repositories.map((repo) => {
      const record = isRecord(repo) ? repo : {};
      return {
        id: stringValue(record.id),
        name: stringValue(record.name) || stringValue(record.id),
        path: stringValue(record.path),
        tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : splitList(stringValue(record.tags))
      };
    }) : [],
    providers: Array.isArray(input.providers) ? input.providers.map((provider) => {
      const record = isRecord(provider) ? provider : {};
      return {
        id: stringValue(record.id),
        type: stringValue(record.type) || "future",
        enabled: record.enabled === true,
        apiKeyRef: nullableString(record.apiKeyRef),
        defaultModel: nullableString(record.defaultModel),
        command: nullableString(record.command)
      };
    }) : [],
    runs: {
      defaultRoots: isRecord(input.runs) && Array.isArray(input.runs.defaultRoots)
        ? input.runs.defaultRoots.map(stringValue)
        : []
    }
  };
}

function validateId(id: string, diagnostics: AdminConfigDiagnostic[], path: string, label: string): void {
  if (!id.trim()) {
    diagnostics.push({ level: "error", code: `${label}_id_required`, message: `${capitalize(label)} id is required.`, path });
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    diagnostics.push({ level: "warning", code: `${label}_id_not_slug_like`, message: `${capitalize(label)} id should be stable and slug-like.`, path });
  }
}

function validateOpenRouterProvider(provider: AdminProviderConfig, diagnostics: AdminConfigDiagnostic[], base: string): void {
  const ref = provider.apiKeyRef ?? "";
  if (!ref.trim()) {
    diagnostics.push({ level: provider.enabled ? "error" : "warning", code: "openrouter_api_key_ref_missing", message: `OpenRouter provider ${provider.id || "unknown"} should use an env: token reference.`, path: `${base}.apiKeyRef` });
    return;
  }
  if (containsRawToken(ref)) {
    diagnostics.push({ level: "error", code: "provider_raw_token_rejected", message: "Provider token fields must contain references only, never raw token values.", path: `${base}.apiKeyRef` });
    return;
  }
  if (!ref.startsWith("env:")) {
    diagnostics.push({ level: "error", code: "openrouter_api_key_ref_invalid", message: "OpenRouter apiKeyRef must be an env: reference such as env:OPENROUTER_API_KEY.", path: `${base}.apiKeyRef` });
  }
}

export function containsRawToken(value: string): boolean {
  if (/^env:[A-Z_][A-Z0-9_]*$/i.test(value)) return false;
  if (/^local:[A-Za-z0-9._/-]+$/i.test(value)) return false;
  return /\bsk-or-v1-[A-Za-z0-9._-]{8,}\b/i.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}$/.test(value)
    || /(?:api[_-]?key|token|secret|password)\s*[:=]/i.test(value);
}

function diffCollection<T extends { id: string }>(label: string, before: T[], after: T[], describe: (value: T) => string): string[] {
  const lines: string[] = [];
  const beforeMap = new Map(before.map((item) => [item.id, item]));
  const afterMap = new Map(after.map((item) => [item.id, item]));
  for (const [id, item] of afterMap) {
    if (!beforeMap.has(id)) lines.push(`${label} added: ${id} (${describe(item)})`);
    else if (JSON.stringify(redactJson(beforeMap.get(id))) !== JSON.stringify(redactJson(item))) lines.push(`${label} changed: ${id}`);
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) lines.push(`${label} removed: ${id}`);
  }
  return lines;
}

function diffRunRoots(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.filter((root) => !beforeSet.has(root)).map((root) => `Run root added: ${root}`),
    ...before.filter((root) => !afterSet.has(root)).map((root) => `Run root removed: ${root}`)
  ];
}

function duplicateDiagnostics(counts: Map<string, number>, code: string, message: string, path: string, diagnostics: AdminConfigDiagnostic[], level: "error" | "warning" = "error"): void {
  for (const [value, countValue] of counts) {
    if (value && countValue > 1) diagnostics.push({ level, code, message: `${message}: ${value}`, path });
  }
}

function count(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function redactProvider(provider: AdminProviderConfig): AdminProviderConfig {
  return { ...provider, apiKeyRef: redactedRef(provider.apiKeyRef) };
}

function summarizeValue(value: unknown): string {
  return redactSecrets(JSON.stringify(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
