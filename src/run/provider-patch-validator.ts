import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProviderPatchContract {
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  maxFilesChanged?: number;
  maxPatchBytes?: number;
}

export interface ProviderPatchValidationResult {
  accepted: boolean;
  filesChanged: string[];
  errors: string[];
  patchBytes: number;
  maxPatchBytes: number;
  maxFilesChanged: number;
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: {
    parseable: boolean;
    binaryDiff: boolean;
    absolutePaths: boolean;
    pathTraversal: boolean;
    forbiddenPaths: boolean;
    allowedPaths: boolean;
    maxFilesChanged: boolean;
    maxPatchBytes: boolean;
    suspiciousFileModes: boolean;
    hasFileChanges: boolean;
    dryRunApply: "passed" | "failed" | "not_run";
  };
}

const defaultForbiddenPaths = [
  ".env",
  ".env.*",
  "**/secrets/**",
  "secrets/**",
  "deploy/**",
  "infra/**",
  ".github/**",
  "Dockerfile",
  "docker/**",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
];

const defaultMaxFilesChanged = 3;
const defaultMaxPatchBytes = 50_000;

export async function validateProviderPatch(input: {
  patch: string;
  repoPath: string;
  contract?: ProviderPatchContract | null;
}): Promise<ProviderPatchValidationResult> {
  const contract = normalizeContract(input.contract);
  const patchBytes = Buffer.byteLength(input.patch, "utf8");
  const errors: string[] = [];
  const checks: ProviderPatchValidationResult["checks"] = {
    parseable: true,
    binaryDiff: false,
    absolutePaths: false,
    pathTraversal: false,
    forbiddenPaths: false,
    allowedPaths: true,
    maxFilesChanged: true,
    maxPatchBytes: patchBytes <= contract.maxPatchBytes,
    suspiciousFileModes: false,
    hasFileChanges: false,
    dryRunApply: "not_run"
  };

  if (!input.patch.trim()) {
    checks.parseable = false;
    errors.push("provider output did not contain a patch");
  }
  if (!checks.maxPatchBytes) errors.push(`patch exceeds maxPatchBytes ${contract.maxPatchBytes}`);

  const parsed = parseUnifiedDiff(input.patch);
  if (parsed.errors.length > 0) {
    checks.parseable = false;
    errors.push(...parsed.errors);
  }
  if (parsed.binaryDiff) {
    checks.binaryDiff = true;
    errors.push("binary diffs are not supported");
  }
  if (parsed.suspiciousFileModes) {
    checks.suspiciousFileModes = true;
    errors.push("file mode changes are not supported");
  }
  if (parsed.changedLineCount > 0) checks.hasFileChanges = true;
  if (!checks.hasFileChanges && input.patch.trim()) errors.push("patch contains no file changes");

  const files = [...new Set(parsed.files.map((file) => normalizeRepoPath(file)))].sort();
  for (const file of files) {
    if (isAbsoluteRepoPath(file)) {
      checks.absolutePaths = true;
      errors.push(`patch uses an absolute path: ${file}`);
    }
    if (escapesWorkspace(file)) {
      checks.pathTraversal = true;
      errors.push(`patch touches path outside repo scope: ${file}`);
    }
    if (matchesAny(file, contract.forbiddenPaths)) {
      checks.forbiddenPaths = true;
      errors.push(`patch touches forbidden path: ${file}`);
    }
    if (contract.allowedPaths.length > 0 && !matchesAny(file, contract.allowedPaths)) {
      checks.allowedPaths = false;
      errors.push(`patch touches path outside allowedPaths: ${file}`);
    }
  }
  if (files.length === 0 && input.patch.trim()) errors.push("patch does not declare changed files");
  if (files.length > contract.maxFilesChanged) {
    checks.maxFilesChanged = false;
    errors.push(`patch changes ${files.length} files, exceeding maxFilesChanged ${contract.maxFilesChanged}`);
  }

  const structuralErrors = errors.length > 0;
  if (!structuralErrors) {
    checks.dryRunApply = await dryRunApply(input.repoPath, input.patch);
    if (checks.dryRunApply !== "passed") errors.push("patch failed dry-run apply");
  }

  return {
    accepted: errors.length === 0,
    filesChanged: files,
    errors: [...new Set(errors)],
    patchBytes,
    maxPatchBytes: contract.maxPatchBytes,
    maxFilesChanged: contract.maxFilesChanged,
    allowedPaths: contract.allowedPaths,
    forbiddenPaths: contract.forbiddenPaths,
    checks
  };
}

function normalizeContract(contract?: ProviderPatchContract | null): Required<ProviderPatchContract> {
  return {
    allowedPaths: contract?.allowedPaths?.filter(Boolean) ?? [],
    forbiddenPaths: [...defaultForbiddenPaths, ...(contract?.forbiddenPaths?.filter(Boolean) ?? [])],
    maxFilesChanged: contract?.maxFilesChanged ?? defaultMaxFilesChanged,
    maxPatchBytes: contract?.maxPatchBytes ?? defaultMaxPatchBytes
  };
}

function parseUnifiedDiff(patch: string): {
  files: string[];
  errors: string[];
  binaryDiff: boolean;
  suspiciousFileModes: boolean;
  changedLineCount: number;
} {
  const files: string[] = [];
  const errors: string[] = [];
  let binaryDiff = false;
  let suspiciousFileModes = false;
  let changedLineCount = 0;
  let current: { oldPath: string; newPath: string; sawOld: boolean; sawNew: boolean; sawHunk: boolean } | null = null;
  let diffCount = 0;

  for (const line of patch.split("\n")) {
    const diff = /^diff --git (.+) (.+)$/.exec(line);
    if (diff) {
      if (current && (!current.sawOld || !current.sawNew || !current.sawHunk)) errors.push(`malformed diff for ${current.newPath}`);
      const oldPath = stripDiffPrefix(diff[1]!);
      const newPath = stripDiffPrefix(diff[2]!);
      current = { oldPath, newPath, sawOld: false, sawNew: false, sawHunk: false };
      files.push(oldPath, newPath);
      diffCount += 1;
      continue;
    }
    if (/^Binary files /.test(line) || /^GIT binary patch$/.test(line)) binaryDiff = true;
    if (/^(old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to) /.test(line)) suspiciousFileModes = true;
    if (!current) continue;
    const oldHeader = /^--- (.+)$/.exec(line);
    if (oldHeader) {
      const oldPath = stripDiffPrefix(oldHeader[1]!);
      if (oldPath !== "/dev/null") files.push(oldPath);
      current.sawOld = true;
      continue;
    }
    const newHeader = /^\+\+\+ (.+)$/.exec(line);
    if (newHeader) {
      const newPath = stripDiffPrefix(newHeader[1]!);
      if (newPath !== "/dev/null") files.push(newPath);
      current.sawNew = true;
      continue;
    }
    if (/^@@ /.test(line)) {
      current.sawHunk = true;
      continue;
    }
    if (current.sawHunk && (/^\+[^+]/.test(line) || /^-[^-]/.test(line))) changedLineCount += 1;
  }
  if (current && (!current.sawOld || !current.sawNew || !current.sawHunk)) errors.push(`malformed diff for ${current.newPath}`);
  if (diffCount === 0 && patch.trim()) errors.push("patch is not a parseable git unified diff");
  return { files, errors, binaryDiff, suspiciousFileModes, changedLineCount };
}

function stripDiffPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function normalizeRepoPath(path: string): string {
  return normalize(path).replace(/\\/g, "/");
}

function isAbsoluteRepoPath(path: string): boolean {
  return path.startsWith("/");
}

function escapesWorkspace(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.includes("\0");
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function dryRunApply(repoPath: string, patch: string): Promise<"passed" | "failed"> {
  const tempDir = resolve(tmpdir(), `runforge-provider-patch-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const patchPath = join(tempDir, "provider.patch");
  try {
    await writeFile(patchPath, patch, "utf8");
    await execFileAsync("git", ["apply", "--check", patchPath], { cwd: repoPath, maxBuffer: 1024 * 1024 });
    return "passed";
  } catch {
    return "failed";
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
