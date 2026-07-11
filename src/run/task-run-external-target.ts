import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { blockedCommandReports } from "./external-command-check-helpers.js";
import type { TaskRunRuntime } from "./task-run-harness.js";

export async function assertExternalTaskPolicy(input: {
  repo: string;
  runtime: TaskRunRuntime;
  delegatedReview?: "mock" | "cli";
  commands: string[];
}): Promise<void> {
  if (input.runtime !== "docker") throw new Error("--repo requires --runtime docker.");
  if (input.delegatedReview) throw new Error("External task-run uses providerless deterministic review; delegated review is not allowed.");
  const info = await stat(input.repo).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`--repo must be an existing directory: ${input.repo}`);
  const blocked = blockedCommandReports(input.commands, "main");
  if (blocked[0]) throw new Error(blocked[0].reason);
}

export async function assertExternalPathsOutsideTarget(repo: string, paths: string[]): Promise<void> {
  const canonicalRepo = await canonicalPath(repo);
  for (const path of paths) {
    const canonical = await canonicalPath(path);
    const fromTarget = relative(canonicalRepo, canonical);
    const inside = fromTarget === "" || (fromTarget !== ".." && !fromTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromTarget));
    if (inside) throw new Error(`External task-run paths that may be cleaned or written must be outside --repo: ${path}`);
  }
}

async function canonicalPath(input: string): Promise<string> {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return missing.reduceRight((path, segment) => join(path, segment), existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error(`Cannot safely resolve path ${input}: ${String(error)}`);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Cannot safely resolve path ${input}.`);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}
