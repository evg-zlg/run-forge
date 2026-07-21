import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { scanSecrets } from "../security/secret-scan.js";
import type { ImplementationExecutorRequest } from "./executor.js";

// Minimal deterministic trimming for noisy evidence
function trimEvidence(text: string, maxLines = 28, maxBytes = 3072): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/).map((line) => line.trimEnd())) {
    const line = raw === "" ? "" : raw;
    if (lines.at(-1) !== line && !(line === "" && lines.at(-1) === "")) lines.push(line);
  }
  const critical = new Set<number>(), selected = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (/\berr(?:or)?\b|fail|exception|stack|diagnostic|traceback|panic|fatal|assert/i.test(lines[i]!)) {
      critical.add(i);
      if (i > 0) critical.add(i - 1);
      if (i < lines.length - 1) critical.add(i + 1);
    }
  }
  for (const index of critical) {
    if (selected.size >= maxLines) break;
    selected.add(index);
  }
  for (let i = 0; i < Math.min(4, lines.length) && selected.size < maxLines; i++) selected.add(i);
  for (let i = Math.max(0, lines.length - 4); i < lines.length && selected.size < maxLines; i++) selected.add(i);
  for (let i = 0; i < lines.length && selected.size < maxLines; i++) selected.add(i);
  const output = [...selected].sort((a, b) => a - b).map((index) => lines[index]!).join("\n");
  if (Buffer.byteLength(output) <= maxBytes) return output;
  return Buffer.from(output).subarray(0, maxBytes).toString("utf8").replace(/[^\n]*$/, "").trimEnd();
}

// Detect noisy evidence files by extension
function isNoisyEvidence(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.endsWith(".log") ||
    lower.endsWith(".out") ||
    lower.endsWith(".err") ||
    (lower.endsWith(".json") && ["validation", "result", "diagnostic"].some((token) => lower.includes(token)))
  );
}

// README and documentation files are useful as orientation, but are frequently
// much larger than the code change they describe. Treat them as evidence for
// small models: keep their structure and the actionable bits, rather than
// silently spending the whole context window on prose.
function isReferenceText(file: string): boolean {
  const lower = file.toLowerCase();
  return /(^|\/)(readme|contributing|architecture|design|adr)[^/]*\.(md|mdx|rst|adoc|txt)$/i.test(file)
    || /(^|\/)(docs?|guides?|documentation)\/.+\.(md|mdx|rst|adoc|txt)$/i.test(lower);
}

function trimReferenceText(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const selected = new Set<number>();
  const isHeading = (line: string) => /^\s{0,3}#{1,6}\s+\S/.test(line);
  const isCritical = (line: string) => /\berr(?:or)?\b|fail(?:ed|ure)?|exception|stack|diagnostic|traceback|panic|fatal|assert|\b(todo|fixme|warning)\b/i.test(line);
  const add = (index: number) => {
    if (index >= 0 && index < lines.length && selected.size < maxLines) selected.add(index);
  };

  // Do not let a run of warnings crowd out the document map (or vice versa).
  // Keeping the matched lines themselves lets an implementation model ask for
  // expansion without copying the surrounding manual into its prompt.
  for (let index = 0; index < lines.length && selected.size < maxLines; index++) {
    if (isHeading(lines[index]!)) add(index);
  }
  for (let index = 0; index < lines.length && selected.size < maxLines; index++) {
    if (isCritical(lines[index]!)) add(index);
  }
  for (let index = 0; index < Math.min(6, lines.length) && selected.size < maxLines; index++) add(index);
  for (let index = Math.max(0, lines.length - 6); index < lines.length && selected.size < maxLines; index++) add(index);

  const output = [...selected].sort((a, b) => a - b).map((index) => lines[index]!).join("\n");
  if (Buffer.byteLength(output) <= maxBytes) return output;
  return Buffer.from(output).subarray(0, maxBytes).toString("utf8").replace(/[^\n]*$/, "").trimEnd();
}

export async function buildContextPlan(request: ImplementationExecutorRequest, root: string): Promise<{ plan: Record<string, unknown>; prompt: string; plannerPrompt: string; implementationPrompt: string }> {
  const mentioned = request.spec.task.text.match(/(?:src|tests|scripts|schemas|docs|config)\/[A-Za-z0-9._/-]+/g) ?? [];
  const files = [...new Set([...request.spec.discovery.explicitFiles, ...mentioned])].slice(0, request.spec.discovery.maxFiles);
  const canonicalRoot = await realpath(root);
  const sections: Array<{ file: string; text: string; classification: "source" | "noisy-evidence" | "reference-text" }> = [];
  const reads: Array<Record<string, unknown>> = [];
  const perFileTelemetry: Array<{ file: string; classification: string; deduplicated: boolean; truncated: boolean; criticalLines: number; inputBytes: number; plannerBytes: number; implementationBytes: number }> = [];
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
    const classification = isNoisyEvidence(file) ? "noisy-evidence" : isReferenceText(file) ? "reference-text" : "source";
    sections.push({ file, text, classification });
    const rawLines = text.split(/\r?\n/);
    const beforeDedup = rawLines.length;
    const dedupedLines = rawLines.map((l) => l.trimEnd());
    const deduped: string[] = [];
    for (const l of dedupedLines) {
      const normalized = l.replace(/\s+/g, " ");
      if (deduped.length === 0 || deduped.at(-1)! !== normalized) deduped.push(normalized);
    }
    const plannerText = classification === "noisy-evidence" ? trimEvidence(text, 120, 12_288) : classification === "reference-text" ? trimReferenceText(text, 96, 12_288) : text;
    const implementationText = classification === "noisy-evidence" ? trimEvidence(text, 28, 3_072) : classification === "reference-text" ? trimReferenceText(text, 64, 6_144) : text;
    const truncated = classification !== "source" && (plannerText !== text || implementationText !== text);
    const hasCritical = (l: string) =>
      /\berr(?:or)?\b|fail|exception|stack|diagnostic|traceback|panic|fatal|assert/i.test(l);
    const criticalLines = deduped.filter((l, i) => {
      if (!hasCritical(l)) return false;
      if (i > 0 && hasCritical(deduped[i - 1]!)) return true;
      if (i < deduped.length - 1 && hasCritical(deduped[i + 1]!)) return true;
      return true;
    }).length;
    perFileTelemetry.push({
      file,
      classification,
      deduplicated: beforeDedup !== deduped.length,
      truncated,
      criticalLines,
      inputBytes: Buffer.byteLength(text),
      plannerBytes: Buffer.byteLength(plannerText),
      implementationBytes: Buffer.byteLength(implementationText),
    });
  }
  const totalBytes = reads.reduce((sum, item) => sum + (typeof item.bytes === "number" ? item.bytes : 0), 0);
  const wrap = (file: string, text: string) => `--- BEGIN FILE ${file} ---\n${text}\n--- END FILE ${file} ---`;
  const sourcePrompt = sections.filter((item) => item.classification === "source").map((item) => wrap(item.file, item.text)).join("\n\n");
  const plannerEvidence = sections.filter((item) => item.classification !== "source").map((item) => wrap(item.file, item.classification === "noisy-evidence" ? trimEvidence(item.text, 120, 12_288) : trimReferenceText(item.text, 96, 12_288))).join("\n\n");
  const implementationEvidence = sections.filter((item) => item.classification !== "source").map((item) => wrap(item.file, item.classification === "noisy-evidence" ? trimEvidence(item.text, 28, 3_072) : trimReferenceText(item.text, 64, 6_144))).join("\n\n");
  const plannerPrompt = [sourcePrompt, plannerEvidence].filter(Boolean).join("\n\n");
  const implementationPrompt = [sourcePrompt, implementationEvidence].filter(Boolean).join("\n\n");
  const estimatedTokens = Math.ceil(Buffer.byteLength(implementationPrompt) / 4);

  const omitted = reads
    .filter((item) => item.status !== "planned")
    .map((item) => ({ file: item.file, status: item.status, reason: item.reason, bytes: item.bytes }));
  const expansionHistory: Array<Record<string, unknown>> = [];
  const telemetry = {
    strategy: "bounded-two-stage",
    version: "1",
    rawIncludedBytes: sections.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
    plannerPromptBytes: Buffer.byteLength(plannerPrompt),
    implementationPromptBytes: Buffer.byteLength(implementationPrompt),
    reductionRatio: {
      planner: totalBytes ? Number((Buffer.byteLength(plannerPrompt) / totalBytes).toFixed(4)) : 1,
      implementation: totalBytes ? Number((Buffer.byteLength(implementationPrompt) / totalBytes).toFixed(4)) : 1,
    },
    perFile: perFileTelemetry,
  };
  return {
    plannerPrompt,
    implementationPrompt,
    prompt: implementationPrompt,
    plan: {
      schemaVersion: 2, profile: request.spec.discovery.profile, limits: { maxFiles: request.spec.discovery.maxFiles, maxBytes: request.spec.discovery.maxBytes, maxTokens: request.spec.discovery.maxTokens }, reads, omitted, expansionHistory, deduplicated: true, totalFiles: reads.length, totalBytes, estimatedTokens, withinBounds: reads.length <= request.spec.discovery.maxFiles && totalBytes <= request.spec.discovery.maxBytes && estimatedTokens <= request.spec.discovery.maxTokens, stopCondition: request.spec.discovery.stopCondition, expansionPolicy: "Every additional file requires an explicit reason in provider evidence.",
      compilerTelemetry: telemetry,
    },
  };
}

function isInside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")); }
async function readBounded(path: string, maxBytes: number): Promise<Buffer> { const handle = await open(path, "r"); try { const buffer = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead); } finally { await handle.close(); } }
