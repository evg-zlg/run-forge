import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { scanSecrets } from "../security/secret-scan.js";

export interface ContextPackFileLimits {
  maxBytesPerFile: number;
  maxTotalFiles: number;
  maxTotalBytes: number;
}

export interface ContextPackIncludedFile {
  path: string;
  bytes: number;
  includedBytes: number;
  truncated: boolean;
  sha256: string | null;
  sha256Scope: "full" | "included-prefix";
}

export interface ContextPackFileSummary extends ContextPackIncludedFile {
  lineCount: number;
  excerpt: string;
  secretScan: "passed" | "redacted";
}

export interface ContextPackFileSelection {
  includedFiles: ContextPackIncludedFile[];
  fileSummaries: ContextPackFileSummary[];
  limitations: string[];
}

const defaultSkips = ["node_modules/**", "dist/**", "build/**", "coverage/**", ".git/**", "artifacts/**", "output/**", "tmp/**", "reports/**"];
const defaultSkipRules = defaultSkips.map(globToRegExp);

export async function collectContextPackFiles(input: {
  root: string;
  include: string[];
  exclude: string[];
  limits: ContextPackFileLimits;
}): Promise<ContextPackFileSelection> {
  validateLimits(input.limits);
  const root = resolve(input.root);
  const include = validatePatterns(input.include.length > 0 ? input.include : ["**/*"], "include");
  const exclude = validatePatterns([...defaultSkips, ...input.exclude], "exclude");
  const candidates = (await listFiles(root)).filter((path) => matchesAny(path, include) && !matchesAny(path, exclude)).sort();
  const includedFiles: ContextPackIncludedFile[] = [];
  const fileSummaries: ContextPackFileSummary[] = [];
  const limitations: string[] = [];
  let totalBytes = 0;

  if (candidates.length === 0) {
    limitations.push("No files matched input.include after input.exclude and default safety skips were applied.");
  }

  for (const path of candidates) {
    if (includedFiles.length >= input.limits.maxTotalFiles) {
      limitations.push(`File limit reached at ${input.limits.maxTotalFiles} files.`);
      break;
    }
    const absolutePath = resolve(root, path);
    assertInsideRoot(root, absolutePath);
    const bytes = (await stat(absolutePath)).size;
    if (totalBytes >= input.limits.maxTotalBytes) {
      limitations.push(`Total byte limit reached at ${input.limits.maxTotalBytes} bytes.`);
      break;
    }
    const includedBytes = Math.min(bytes, input.limits.maxBytesPerFile, input.limits.maxTotalBytes - totalBytes);
    const prefix = await readPrefix(absolutePath, includedBytes);
    const text = prefix.toString("utf8");
    const secretScan = scanSecrets(text);
    const truncated = includedBytes < bytes;
    const file = {
      path,
      bytes,
      includedBytes,
      truncated,
      sha256: includedBytes > 0 ? createHash("sha256").update(prefix).digest("hex") : null,
      sha256Scope: truncated ? "included-prefix" as const : "full" as const
    };
    includedFiles.push(file);
    fileSummaries.push({
      ...file,
      lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
      excerpt: secretScan.status === "failed" ? "[redacted: secret-like value detected]" : text,
      secretScan: secretScan.status === "failed" ? "redacted" : "passed"
    });
    if (truncated) limitations.push(`${path} was truncated to ${includedBytes} bytes.`);
    totalBytes += includedBytes;
  }

  return { includedFiles, fileSummaries, limitations };
}

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  if (bytes <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const result = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export function validateContextPackPatterns(patterns: string[], field: string): void {
  validatePatterns(patterns, field);
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, "", found);
  return found;
}

async function walk(root: string, current: string, found: string[]): Promise<void> {
  const absolute = resolve(root, current);
  assertInsideRoot(root, absolute);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const child = toPosix(join(current, entry.name));
    if (matchesAny(child, defaultSkipRules)) continue;
    const childAbsolute = resolve(root, child);
    assertInsideRoot(root, childAbsolute);
    if (entry.isDirectory()) await walk(root, child, found);
    else if (entry.isFile()) found.push(child);
  }
}

function validatePatterns(patterns: string[], field: string): RegExp[] {
  return patterns.map((pattern) => {
    if (pattern.trim() !== pattern || pattern.length === 0) throw new Error(`RunSpec input.${field} contains an empty pattern.`);
    if (isAbsolute(pattern) || pattern.startsWith("/") || pattern.startsWith("\\") || pattern.includes("\\")) {
      throw new Error(`RunSpec input.${field} patterns must be relative POSIX paths.`);
    }
    const parts = pattern.split("/");
    if (parts.includes("..") || parts.includes(".")) {
      throw new Error(`RunSpec input.${field} patterns must not contain path traversal.`);
    }
    return globToRegExp(pattern);
  });
}

function validateLimits(limits: ContextPackFileLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`RunSpec input.${name} must be a positive integer.`);
  }
}

function matchesAny(path: string, rules: RegExp[]): boolean {
  return rules.some((rule) => rule.test(path));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      const after = pattern[index + 2];
      source += after === "/" ? "(?:.*/)?" : ".*";
      index += after === "/" ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function assertInsideRoot(root: string, path: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const rel = relative(normalizedRoot, normalizedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Context pack attempted to read outside the repository root.");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
