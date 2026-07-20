import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { scanSecrets } from "../security/secret-scan.js";
import type { ImplementationExecutorRequest } from "./executor.js";

export async function buildContextPlan(request: ImplementationExecutorRequest, root: string): Promise<{ plan: Record<string, unknown>; prompt: string }> {
  const mentioned = request.spec.task.text.match(/(?:src|tests|scripts|schemas|docs|config)\/[A-Za-z0-9._/-]+/g) ?? [];
  const files = [...new Set([...request.spec.discovery.explicitFiles, ...mentioned])].slice(0, request.spec.discovery.maxFiles);
  const canonicalRoot = await realpath(root);
  const contents: string[] = [];
  const reads: Array<Record<string, unknown>> = [];
  let plannedBytes = 0;
  for (const file of files) {
    const path = resolve(root, file);
    if (!isInside(root, path)) { reads.push({ file, status: "rejected", reason: "path escapes workspace" }); continue; }
    const metadata = await lstat(path).catch(() => null);
    if (!metadata) { reads.push({ file, status: "missing_or_new", bytes: 0, reason: "explicit task scope" }); continue; }
    if (!metadata.isFile() || metadata.isSymbolicLink()) { reads.push({ file, status: "rejected", bytes: 0, reason: "non-regular file" }); continue; }
    const canonicalPath = await realpath(path).catch(() => null);
    if (!canonicalPath || !isInside(canonicalRoot, canonicalPath)) { reads.push({ file, status: "rejected", bytes: 0, reason: "resolved path escapes workspace" }); continue; }
    const bytes = metadata.size, remainingBytes = request.spec.discovery.maxBytes - plannedBytes;
    plannedBytes += bytes;
    if (bytes > remainingBytes) { reads.push({ file, status: "rejected", bytes, reason: "context byte limit exceeded" }); continue; }
    const value = await readBounded(canonicalPath, remainingBytes);
    if (value.byteLength > remainingBytes) { reads.push({ file, status: "rejected", bytes: value.byteLength, reason: "context byte limit exceeded" }); continue; }
    const text = value.toString("utf8");
    if (value.includes(0)) { reads.push({ file, status: "rejected", bytes, reason: "binary content" }); continue; }
    if (scanSecrets(text).status === "failed") { reads.push({ file, status: "rejected", bytes, reason: "secret-like content" }); continue; }
    reads.push({ file, status: "planned", bytes, reason: "explicit task scope" });
    contents.push(`--- BEGIN FILE ${file} ---\n${text}\n--- END FILE ${file} ---`);
  }
  const totalBytes = reads.reduce((sum, item) => sum + (typeof item.bytes === "number" ? item.bytes : 0), 0);
  const estimatedTokens = Math.ceil(Buffer.byteLength(contents.join("\n\n")) / 4);
  const omitted = reads
    .filter((item) => item.status !== "planned")
    .map((item) => ({ file: item.file, status: item.status, reason: item.reason, bytes: item.bytes }));
  const expansionHistory: Array<Record<string, unknown>> = [];
  return {
    prompt: contents.join("\n\n"),
    plan: {
      schemaVersion: 1, profile: request.spec.discovery.profile, limits: { maxFiles: request.spec.discovery.maxFiles, maxBytes: request.spec.discovery.maxBytes, maxTokens: request.spec.discovery.maxTokens }, reads, omitted, expansionHistory, deduplicated: true, totalFiles: reads.length, totalBytes, estimatedTokens, withinBounds: reads.length <= request.spec.discovery.maxFiles && totalBytes <= request.spec.discovery.maxBytes && estimatedTokens <= request.spec.discovery.maxTokens, stopCondition: request.spec.discovery.stopCondition, expansionPolicy: "Every additional file requires an explicit reason in provider evidence."
    }
  };
}

function isInside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")); }
async function readBounded(path: string, maxBytes: number): Promise<Buffer> { const handle = await open(path, "r"); try { const buffer = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead); } finally { await handle.close(); } }
