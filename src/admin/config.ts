import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { redactJson } from "./redaction.js";

export type AdminProviderType = "openrouter" | "cli" | "future" | string;

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
  schemaVersion: string;
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
  const parent = dirname(configPath);
  const tempPath = join(parent, `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(redactJson(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    const handle = await open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not support fsync in the current execution environment.
  }
  await rename(tempPath, configPath);
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Some filesystems ignore POSIX permissions. The config still contains no raw token values.
  }
  try {
    const parentHandle = await open(parent, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch {
    // Directory fsync is best effort for local atomic write durability.
  }
}

export async function backupAdminConfig(path: string): Promise<string | null> {
  const configPath = resolve(path);
  try {
    await stat(configPath);
  } catch {
    return null;
  }
  const backupPath = `${configPath}.bak`;
  await writeFile(backupPath, await readFile(configPath));
  try {
    await chmod(backupPath, 0o600);
  } catch {
    // Best effort only.
  }
  return backupPath;
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
  const type = typeof value.type === "string" && value.type ? value.type : "future";
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
