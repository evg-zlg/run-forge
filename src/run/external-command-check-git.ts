import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { GitSnapshot, MutationVerdict } from "./external-command-check-types.js";

const copyExcludeNames = new Set(["node_modules", ".git", "dist", "build", "coverage", ".turbo", ".next", ".cache"]);

export async function prepareWorkspace(repoPath: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "runforge-workspace-"));
  const workspacePath = join(parent, basename(repoPath) || "repo");
  await cp(repoPath, workspacePath, {
    recursive: true,
    dereference: false,
    filter: (source) => !copyExcludeNames.has(basename(source))
  });
  return workspacePath;
}

export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  const head = await runGit(["rev-parse", "HEAD"], cwd);
  const status = await runGit(["status", "--short"], cwd);
  return {
    head: head.ok ? head.stdout.trim() : null,
    status: status.ok ? status.stdout.trim() : null,
    error: head.ok && status.ok ? undefined : gitErrors(head, status)
  };
}

export function mutationVerdictFor(before: GitSnapshot, after: GitSnapshot): MutationVerdict {
  if (before.head === null || after.head === null || before.status === null || after.status === null) return "unknown";
  return before.head === after.head && before.status === after.status ? "unchanged" : "changed";
}

export interface WorkspaceFileEntry {
  type: "file";
  size: number;
  mtimeMs: number;
  hash: string;
}

export type WorkspaceFileSnapshot = Map<string, WorkspaceFileEntry>;

export interface WorkspaceChangeSummary {
  method: "filesystem_snapshot";
  status: "ok" | "unknown";
  fileChanges: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  counts: {
    added: number;
    modified: number;
    deleted: number;
  };
  error: string | null;
}

export async function snapshotWorkspaceFiles(workspacePath: string): Promise<WorkspaceFileSnapshot> {
  const files = await collectFiles(workspacePath);
  const snapshot: WorkspaceFileSnapshot = new Map();
  for (const file of files) {
    const bytes = await readFile(file);
    const info = await lstat(file);
    snapshot.set(relative(workspacePath, file), {
      type: "file",
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return snapshot;
}

export function diffWorkspaceSnapshots(before: WorkspaceFileSnapshot, after: WorkspaceFileSnapshot): WorkspaceChangeSummary {
  const added = [...after.keys()].filter((file) => !before.has(file)).sort();
  const deleted = [...before.keys()].filter((file) => !after.has(file)).sort();
  const modified = [...after.entries()]
    .filter(([file, entry]) => before.has(file) && before.get(file)?.hash !== entry.hash)
    .map(([file]) => file)
    .sort();
  return {
    method: "filesystem_snapshot",
    status: "ok",
    fileChanges: { added, modified, deleted },
    counts: {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length
    },
    error: null
  };
}

export function unknownWorkspaceChangeSummary(error: string): WorkspaceChangeSummary {
  return {
    method: "filesystem_snapshot",
    status: "unknown",
    fileChanges: { added: [], modified: [], deleted: [] },
    counts: { added: 0, modified: 0, deleted: 0 },
    error
  };
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveResult) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolveResult({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) resolveResult({ ok: true, stdout });
      else resolveResult({ ok: false, error: stderr.trim() || `git ${args.join(" ")} exited ${code}` });
    });
  });
}

function gitErrors(...results: GitResult[]): string {
  return results
    .filter((result): result is { ok: false; error: string } => !result.ok)
    .map((result) => result.error)
    .join("; ");
}

async function collectFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return collectFiles(child);
    if (entry.isFile()) return [child];
    return [];
  }));
  return nested.flat();
}
