import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { redactJson } from "./redaction.js";

export type AdminProviderType = "openrouter" | "cli" | "future";

export interface AdminRepositoryConfig {
  id: string;
  name: string;
  path: string;
  tags: string[];
}

export interface AdminProviderConfig {
  id: string;
  type: AdminProviderType;
  enabled: boolean;
  apiKeyRef?: string | null;
  defaultModel?: string | null;
  command?: string | null;
}

export interface AdminConfig {
  schemaVersion: "admin-alpha";
  repositories: AdminRepositoryConfig[];
  providers: AdminProviderConfig[];
  runs: {
    defaultRoots: string[];
  };
}

export interface LoadAdminConfigResult {
  path: string;
  exists: boolean;
  config: AdminConfig;
}

export function defaultAdminConfigPath(): string {
  return resolve(homedir(), ".runforge/config.json");
}

export function defaultAdminConfig(): AdminConfig {
  return {
    schemaVersion: "admin-alpha",
    repositories: [],
    providers: [
      {
        id: "openrouter",
        type: "openrouter",
        enabled: false,
        apiKeyRef: "env:OPENROUTER_API_KEY",
        defaultModel: null
      },
      {
        id: "codex-cli",
        type: "cli",
        enabled: false,
        command: null
      }
    ],
    runs: {
      defaultRoots: ["validation/runs"]
    }
  };
}

export async function loadAdminConfig(path = defaultAdminConfigPath()): Promise<LoadAdminConfigResult> {
  const configPath = resolve(path);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return { path: configPath, exists: false, config: defaultAdminConfig() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid RunForge admin config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: configPath, exists: true, config: normalizeConfig(parsed) };
}

export async function writeAdminConfig(path: string, config: AdminConfig): Promise<void> {
  const configPath = resolve(path);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(redactJson(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Some filesystems ignore POSIX permissions. The config still contains no raw token values.
  }
}

export function upsertRepository(config: AdminConfig, repo: AdminRepositoryConfig): AdminConfig {
  return {
    ...config,
    repositories: upsertById(config.repositories, repo)
  };
}

export function upsertProvider(config: AdminConfig, provider: AdminProviderConfig): AdminConfig {
  return {
    ...config,
    providers: upsertById(config.providers, provider)
  };
}

function normalizeConfig(value: unknown): AdminConfig {
  const input = isRecord(value) ? value : {};
  const defaults = defaultAdminConfig();
  return {
    schemaVersion: "admin-alpha",
    repositories: Array.isArray(input.repositories)
      ? input.repositories.map(normalizeRepository).filter(Boolean) as AdminRepositoryConfig[]
      : defaults.repositories,
    providers: Array.isArray(input.providers)
      ? input.providers.map(normalizeProvider).filter(Boolean) as AdminProviderConfig[]
      : defaults.providers,
    runs: {
      defaultRoots: isRecord(input.runs) && Array.isArray(input.runs.defaultRoots)
        ? input.runs.defaultRoots.filter((item): item is string => typeof item === "string")
        : defaults.runs.defaultRoots
    }
  };
}

function normalizeRepository(value: unknown): AdminRepositoryConfig | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string") return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    path: value.path,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : []
  };
}

function normalizeProvider(value: unknown): AdminProviderConfig | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const type = value.type === "openrouter" || value.type === "cli" || value.type === "future" ? value.type : "future";
  return {
    id: value.id,
    type,
    enabled: value.enabled === true,
    apiKeyRef: typeof value.apiKeyRef === "string" ? value.apiKeyRef : null,
    defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : null,
    command: typeof value.command === "string" ? value.command : null
  };
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const existing = items.findIndex((item) => item.id === next.id);
  if (existing === -1) return [...items, next];
  return items.map((item, index) => index === existing ? next : item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
