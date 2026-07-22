import { createHash } from "node:crypto";
import { scanSecrets } from "../security/secret-scan.js";

export type RawLogSourceV1 = { ref: string; content: string };
export type RawLogSourceMetadataV1 = {
  ref: string;
  rawSha256: string;
  sanitizedSha256: string;
  rawBytes: number;
  sanitizedBytes: number;
  promptBytes: number;
  truncated: boolean;
};
export type RawLogDigestV1 = {
  schemaVersion: 1;
  kind: "raw-log-digest";
  phase: "logCompression";
  sources: Array<RawLogSourceMetadataV1 & { redactions: number }>;
  chunks: Array<{ ref: string; text: string; sha256: string; bytes: number; truncated: boolean }>;
  totalPromptBytes: number;
};
export type RawLogDigestMetadataV1 = Omit<RawLogDigestV1, "chunks">;
export type LogDigestV1 = {
  schemaVersion: 1;
  kind: "log-digest";
  summary: string;
  failureClass: string | null;
  diagnostics: string[];
  sources: RawLogSourceMetadataV1[];
};
export type LogCompressionInvoker = (request: {
  phase: "logCompression";
  prompt: string;
  rawDigest: RawLogDigestV1;
}) => Promise<{
  content: string; model: string; requestId?: string | null;
  tokenUsage?: number | null; inputTokens?: number | null; outputTokens?: number | null;
  reasoningTokens?: number | null; costUsd?: number | null; attempts?: number;
}>;
export type RawLogCompressionLimits = {
  maxSources: number;
  maxSourcePromptBytes: number;
  maxTotalPromptBytes: number;
  maxOutputBytes: number;
  maxSummaryBytes: number;
  maxDiagnostics: number;
  maxDiagnosticBytes: number;
};
export type RawLogCompressionFailureCode =
  | "empty_sources"
  | "invalid_source"
  | "secret_redaction_failed"
  | "recursive_compression"
  | "provider_failed"
  | "invalid_provider_result"
  | "output_too_large"
  | "unsafe_output"
  | "invalid_digest"
  | "source_mismatch";

export class RawLogCompressionError extends Error {
  readonly blocksDownstream = true as const;
  constructor(readonly code: RawLogCompressionFailureCode, message: string) {
    super(`raw_log_compression_required:${code}:${message}`);
    this.name = "RawLogCompressionError";
  }
}

const defaults: RawLogCompressionLimits = {
  maxSources: 32,
  maxSourcePromptBytes: 16_384,
  maxTotalPromptBytes: 65_536,
  maxOutputBytes: 16_384,
  maxSummaryBytes: 4_096,
  maxDiagnostics: 20,
  maxDiagnosticBytes: 1_024,
};
const activeInvokers = new WeakSet<LogCompressionInvoker>();

/**
 * Produces the only evidence safe to forward to expensive provider phases.
 * The caller retains authoritative raw logs locally; this result contains no raw text.
 */
export async function compressRawLogs(input: {
  sources: RawLogSourceV1[];
  invoke: LogCompressionInvoker;
  limits?: Partial<RawLogCompressionLimits>;
}): Promise<{ digest: LogDigestV1; model: string; requestId: string | null; rawDigestMetadata: RawLogDigestMetadataV1 }> {
  const limits = normalizeLimits(input.limits);
  const rawDigest = prepareRawLogDigest(input.sources, limits);
  if (activeInvokers.has(input.invoke)) throw new RawLogCompressionError("recursive_compression", "the log compressor cannot invoke itself");
  activeInvokers.add(input.invoke);
  let response: Awaited<ReturnType<LogCompressionInvoker>>;
  try {
    response = await input.invoke({ phase: "logCompression", prompt: compressionPrompt(rawDigest), rawDigest });
  } catch (error) {
    if (error instanceof RawLogCompressionError) throw error;
    throw new RawLogCompressionError("provider_failed", "the logCompression provider invocation failed");
  } finally {
    activeInvokers.delete(input.invoke);
  }
  if (!response || typeof response.content !== "string" || typeof response.model !== "string" || !response.model.trim()) {
    throw new RawLogCompressionError("invalid_provider_result", "the logCompression invocation returned no model or content");
  }
  const digest = parseLogDigest(response.content, rawDigest, limits);
  const { chunks: _chunks, ...rawDigestMetadata } = rawDigest;
  return { digest, model: response.model.trim(), requestId: response.requestId ?? null, rawDigestMetadata };
}

export function prepareRawLogDigest(sources: RawLogSourceV1[], limits: RawLogCompressionLimits = defaults): RawLogDigestV1 {
  if (!Array.isArray(sources) || sources.length === 0) throw new RawLogCompressionError("empty_sources", "at least one raw log source is required");
  if (sources.length > limits.maxSources) throw new RawLogCompressionError("invalid_source", `source count exceeds ${limits.maxSources}`);
  const seen = new Set<string>();
  const metadata: RawLogDigestV1["sources"] = [];
  const chunks: RawLogDigestV1["chunks"] = [];
  let remaining = limits.maxTotalPromptBytes;
  for (const source of sources) {
    if (!source || typeof source.ref !== "string" || !source.ref.trim() || source.ref.length > 512 || /[\0\r\n]/.test(source.ref) || typeof source.content !== "string") {
      throw new RawLogCompressionError("invalid_source", "each source requires a bounded single-line ref and string content");
    }
    const ref = source.ref.trim();
    if (seen.has(ref)) throw new RawLogCompressionError("invalid_source", `duplicate source ref: ${ref}`);
    seen.add(ref);
    const rawBytes = Buffer.byteLength(source.content, "utf8");
    const sanitized = sanitize(source.content);
    if (scanSecrets(sanitized.text).status !== "passed") throw new RawLogCompressionError("secret_redaction_failed", `sanitized source still contains secret-like material: ${ref}`);
    const sanitizedBytes = Buffer.byteLength(sanitized.text, "utf8");
    const promptLimit = Math.max(0, Math.min(limits.maxSourcePromptBytes, remaining));
    const text = truncateUtf8(sanitized.text, promptLimit);
    const promptBytes = Buffer.byteLength(text, "utf8");
    const truncated = promptBytes < sanitizedBytes;
    remaining -= promptBytes;
    const sourceMetadata = { ref, rawSha256: sha256(source.content), sanitizedSha256: sha256(sanitized.text), rawBytes, sanitizedBytes, promptBytes, truncated };
    metadata.push({ ...sourceMetadata, redactions: sanitized.redactions });
    chunks.push({ ref, text, sha256: sha256(text), bytes: promptBytes, truncated });
  }
  return { schemaVersion: 1, kind: "raw-log-digest", phase: "logCompression", sources: metadata, chunks, totalPromptBytes: chunks.reduce((sum, item) => sum + item.bytes, 0) };
}

function compressionPrompt(rawDigest: RawLogDigestV1): string {
  return [
    "You are the RunForge logCompression phase. Compress only the supplied sanitized log chunks. Do not call tools, request raw logs, recurse, or invent sources.",
    "Return one strict JSON object and no markdown/prose. Preserve the source metadata exactly.",
    "Required DTO: {\"schemaVersion\":1,\"kind\":\"log-digest\",\"summary\":\"bounded summary\",\"failureClass\":\"lowercase.class-or-null\",\"diagnostics\":[\"bounded diagnostic\"],\"sources\":[{\"ref\":\"...\",\"rawSha256\":\"...\",\"sanitizedSha256\":\"...\",\"rawBytes\":0,\"sanitizedBytes\":0,\"promptBytes\":0,\"truncated\":false}]}",
    JSON.stringify(rawDigest),
  ].join("\n\n");
}

function parseLogDigest(content: string, raw: RawLogDigestV1, limits: RawLogCompressionLimits): LogDigestV1 {
  if (Buffer.byteLength(content, "utf8") > limits.maxOutputBytes) throw new RawLogCompressionError("output_too_large", `digest exceeds ${limits.maxOutputBytes} bytes`);
  if (scanSecrets(content).status !== "passed") throw new RawLogCompressionError("unsafe_output", "digest contains secret-like material");
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new RawLogCompressionError("invalid_digest", "digest is not strict JSON"); }
  const root = strictObject(value, ["schemaVersion", "kind", "summary", "failureClass", "diagnostics", "sources"], "digest");
  if (root.schemaVersion !== 1 || root.kind !== "log-digest") throw new RawLogCompressionError("invalid_digest", "digest schemaVersion or kind is invalid");
  const summary = boundedString(root.summary, limits.maxSummaryBytes, "summary", true);
  const failureClass = root.failureClass === null ? null : boundedString(root.failureClass, 128, "failureClass", true);
  if (failureClass !== null && !/^[a-z0-9][a-z0-9_.-]*$/.test(failureClass)) throw new RawLogCompressionError("invalid_digest", "failureClass must be a lowercase identifier");
  if (!Array.isArray(root.diagnostics) || root.diagnostics.length > limits.maxDiagnostics) throw new RawLogCompressionError("invalid_digest", `diagnostics must contain at most ${limits.maxDiagnostics} strings`);
  const diagnostics = root.diagnostics.map((item, index) => boundedString(item, limits.maxDiagnosticBytes, `diagnostics[${index}]`, true));
  if (!Array.isArray(root.sources) || root.sources.length !== raw.sources.length) throw new RawLogCompressionError("source_mismatch", "digest source count does not match the request");
  const sources = root.sources.map((item, index) => normalizeDigestSource(item, raw.sources[index]!));
  return { schemaVersion: 1, kind: "log-digest", summary, failureClass, diagnostics, sources };
}

function normalizeDigestSource(value: unknown, expected: RawLogDigestV1["sources"][number]): RawLogSourceMetadataV1 {
  const source = strictObject(value, ["ref", "rawSha256", "sanitizedSha256", "rawBytes", "sanitizedBytes", "promptBytes", "truncated"], "digest.sources[]");
  const normalized: RawLogSourceMetadataV1 = {
    ref: source.ref as string, rawSha256: source.rawSha256 as string, sanitizedSha256: source.sanitizedSha256 as string,
    rawBytes: source.rawBytes as number, sanitizedBytes: source.sanitizedBytes as number, promptBytes: source.promptBytes as number, truncated: source.truncated as boolean,
  };
  const authoritative: RawLogSourceMetadataV1 = { ref: expected.ref, rawSha256: expected.rawSha256, sanitizedSha256: expected.sanitizedSha256, rawBytes: expected.rawBytes, sanitizedBytes: expected.sanitizedBytes, promptBytes: expected.promptBytes, truncated: expected.truncated };
  if (JSON.stringify(normalized) !== JSON.stringify(authoritative)) throw new RawLogCompressionError("source_mismatch", `digest metadata does not match source: ${expected.ref}`);
  return authoritative;
}

function sanitize(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const lines = text.split(/\r?\n/).map((line) => {
    if (scanSecrets(line).status === "failed") { redactions += 1; return "[REDACTED SECRET-LIKE LINE]"; }
    let safe = line.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, (_match, prefix: string) => { redactions += 1; return `${prefix}[REDACTED]`; });
    safe = safe.replace(/\b(authorization|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[^\s,;]+/gi, (_match, key: string) => { redactions += 1; return `${key}=[REDACTED]`; });
    return safe;
  });
  return { text: lines.join("\n"), redactions };
}

function normalizeLimits(value: Partial<RawLogCompressionLimits> | undefined): RawLogCompressionLimits {
  const limits = { ...defaults, ...(value ?? {}) };
  for (const [key, item] of Object.entries(limits)) if (!Number.isInteger(item) || item < 1) throw new RawLogCompressionError("invalid_source", `${key} must be a positive integer`);
  return limits;
}
function strictObject(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RawLogCompressionError("invalid_digest", `${name} must be an object`);
  const record = value as Record<string, unknown>, actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new RawLogCompressionError("invalid_digest", `${name} fields are invalid`);
  return record;
}
function boundedString(value: unknown, maxBytes: number, name: string, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && !value.trim()) || Buffer.byteLength(value, "utf8") > maxBytes) throw new RawLogCompressionError("invalid_digest", `${name} is invalid or exceeds ${maxBytes} bytes`);
  return value;
}
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
