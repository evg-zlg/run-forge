import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AdminConfig, AdminProviderConfig } from "./config.js";
import { redactedRef } from "./redaction.js";
import { containsRawToken } from "./config-edit.js";

const execFileAsync = promisify(execFile);

export interface AdminRepositoryDraftStatus {
  id: string;
  path: string;
  exists: boolean;
  git: boolean;
  head: string;
  clean: boolean | null;
}

export interface AdminProviderDraftStatus {
  id: string;
  type: string;
  enabled: boolean;
  apiKeyRef: string;
  tokenStatus: "present" | "missing" | "not_configured" | "local_reference" | "not_applicable" | "invalid";
  defaultModel: string;
  command: string;
}

export interface AdminDraftStatus {
  repositories: AdminRepositoryDraftStatus[];
  providers: AdminProviderDraftStatus[];
  runRoots: Array<{ path: string; absolutePath: string; exists: boolean }>;
}

export async function draftStatus(config: AdminConfig, repoRoot = process.cwd()): Promise<AdminDraftStatus> {
  return {
    repositories: await Promise.all(config.repositories.map(async (repo) => {
      const absolutePath = resolve(repo.path);
      const exists = await pathExists(absolutePath);
      const head = exists ? await gitValue(absolutePath, ["rev-parse", "--short", "HEAD"], "") : "";
      const statusOutput = exists ? await gitValue(absolutePath, ["status", "--porcelain"], "__unknown__") : "";
      return {
        id: repo.id,
        path: absolutePath,
        exists,
        git: Boolean(head),
        head: head || "n/a",
        clean: !head || statusOutput === "__unknown__" ? null : statusOutput.trim().length === 0
      };
    })),
    providers: config.providers.map(providerDraftStatus),
    runRoots: await Promise.all(config.runs.defaultRoots.map(async (root) => {
      const absolutePath = resolve(repoRoot, root);
      return { path: root, absolutePath, exists: await pathExists(absolutePath) };
    }))
  };
}

function providerDraftStatus(provider: AdminProviderConfig): AdminProviderDraftStatus {
  let tokenStatus: AdminProviderDraftStatus["tokenStatus"] = "not_applicable";
  const ref = provider.apiKeyRef ?? "";
  if (provider.type === "openrouter") {
    tokenStatus = !ref
      ? "not_configured"
      : containsRawToken(ref)
        ? "invalid"
        : ref.startsWith("env:")
          ? process.env[ref.slice(4)] ? "present" : "missing"
          : ref.startsWith("local:")
            ? "local_reference"
            : "invalid";
  }
  return {
    id: provider.id,
    type: provider.type,
    enabled: provider.enabled,
    apiKeyRef: redactedRef(ref),
    tokenStatus,
    defaultModel: provider.defaultModel ?? "not configured",
    command: provider.command ?? "not configured"
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitValue(cwd: string, args: string[], fallback: string): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return String(result.stdout).trim();
  } catch {
    return fallback;
  }
}
