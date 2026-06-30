import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInspection } from "../core/types.js";
import { extractMentionedFiles } from "./log-parser.js";

export async function inspectRepo(repoPath: string, logText: string): Promise<RepoInspection> {
  const packageJson = await readPackageJson(repoPath);
  const lockfile = await firstExisting(repoPath, ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
  const guidanceFiles = await existingFiles(repoPath, ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".env.example"]);
  const mentioned = await existingFiles(repoPath, extractMentionedFiles(logText));
  return {
    packageManager: lockfile?.includes("pnpm") ? "pnpm" : lockfile?.includes("yarn") ? "yarn" : lockfile ? "npm" : "unknown",
    scripts: packageJson.scripts ?? {},
    lockfile,
    filesMentionedInLog: mentioned,
    guidanceFiles
  };
}

async function readPackageJson(repoPath: string): Promise<{ scripts?: Record<string, string> }> {
  try {
    return JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return {};
  }
}

async function firstExisting(repoPath: string, files: string[]): Promise<string | undefined> {
  return (await existingFiles(repoPath, files))[0];
}

async function existingFiles(repoPath: string, files: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    try {
      await access(join(repoPath, file));
      found.push(file);
    } catch {
      // Missing files are expected in small fixture repositories.
    }
  }
  return found;
}
