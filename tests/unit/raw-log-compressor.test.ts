import { describe, expect, it, vi } from "vitest";
import {
  RawLogCompressionError,
  compressRawLogs,
  prepareRawLogDigest,
  type LogCompressionInvoker,
  type RawLogDigestV1,
} from "../../src/implementation/raw-log-compressor.js";

describe("raw log compressor", () => {
  it("redacts and bounds raw logs before invoking only logCompression", async () => {
    const secret = `sk-${"x".repeat(24)}`;
    const invoke = vi.fn<LogCompressionInvoker>(async (request) => {
      expect(request.phase).toBe("logCompression");
      expect(request.prompt).not.toContain(secret);
      expect(request.rawDigest.chunks[0]!.text).toContain("[REDACTED SECRET-LIKE LINE]");
      expect(request.rawDigest.chunks[1]!.bytes).toBeLessThanOrEqual(12);
      return response(request.rawDigest);
    });
    const result = await compressRawLogs({
      sources: [{ ref: "stderr.log", content: `failure\nAPI_KEY=${secret}\ntrace` }, { ref: "stdout.log", content: "0123456789abcdefghijklmnopqrstuvwxyz" }],
      limits: { maxSourcePromptBytes: 40, maxTotalPromptBytes: 52 }, invoke,
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.digest).toMatchObject({ schemaVersion: 1, kind: "log-digest", summary: "bounded failure summary", failureClass: "test.failure" });
    expect(result.rawDigestMetadata.sources[0]).toMatchObject({ ref: "stderr.log", rawBytes: expect.any(Number), redactions: 1, truncated: true });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns no raw chunks and verifies exact source hashes and metadata", async () => {
    let captured: RawLogDigestV1 | undefined;
    const result = await compressRawLogs({ sources: [{ ref: "validation/stderr.log", content: "AssertionError: expected 1 to equal 2" }], invoke: async (request) => { captured = request.rawDigest; return response(request.rawDigest); } });
    expect(captured!.sources[0]!.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured!.sources[0]!.sanitizedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rawDigestMetadata).not.toHaveProperty("chunks");
    expect(result.digest.sources).toEqual(captured!.sources.map(({ redactions: _redactions, ...source }) => source));
  });

  it("accepts direct JSON and one complete fenced JSON digest", async () => {
    const sources = [{ ref: "x.log", content: "failed" }];
    const direct = await compressRawLogs({ sources, invoke: async ({ rawDigest }) => response(rawDigest) });
    const fenced = await compressRawLogs({ sources, invoke: async ({ rawDigest }) => ({ ...response(rawDigest), content: `\`\`\`json\n${JSON.stringify(digest(rawDigest))}\n\`\`\`` }) });
    expect(fenced.digest).toEqual(direct.digest);
  });

  it.each([
    "before\nPAYLOAD",
    "PAYLOAD\nafter",
    "before\n```json\nPAYLOAD\n```",
    "```json\nPAYLOAD\n```\nafter",
    "```json\nPAYLOAD\n```\n```json\nPAYLOAD\n```",
  ])("rejects payload extraction from prose or multiple fences", async (template) => {
    const sources = [{ ref: "x.log", content: "failed" }];
    await expect(compressRawLogs({
      sources,
      invoke: async ({ rawDigest }) => ({ ...response(rawDigest), content: template.replaceAll("PAYLOAD", JSON.stringify(digest(rawDigest))) }),
    })).rejects.toMatchObject({ code: "invalid_digest", blocksDownstream: true });
  });

  it.each([
    ["missing source", (raw: RawLogDigestV1) => ({ ...digest(raw), sources: [] }), "source_mismatch"],
    ["changed hash", (raw: RawLogDigestV1) => { const value = digest(raw); return { ...value, sources: [{ ...(value.sources as Array<Record<string, unknown>>)[0]!, rawSha256: "0".repeat(64) }] }; }, "source_mismatch"],
    ["unknown field", (raw: RawLogDigestV1) => ({ ...digest(raw), unexpected: true }), "invalid_digest"],
    ["unbounded summary", (raw: RawLogDigestV1) => ({ ...digest(raw), summary: "x".repeat(5000) }), "invalid_digest"],
  ])("fails closed for %s", async (_name, mutate, code) => {
    const downstream = vi.fn();
    await expect(compressRawLogs({ sources: [{ ref: "x.log", content: "failed" }], invoke: async ({ rawDigest }) => ({ ...response(rawDigest), content: JSON.stringify(mutate(rawDigest)) }) }).then(downstream)).rejects.toMatchObject({ code, blocksDownstream: true });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("fails closed when the provider fails, returns malformed JSON, or emits secret-like output", async () => {
    const source = [{ ref: "x.log", content: "failed" }];
    await expect(compressRawLogs({ sources: source, invoke: async () => { throw new Error("network with raw diagnostic"); } })).rejects.toMatchObject({ code: "provider_failed", blocksDownstream: true });
    await expect(compressRawLogs({ sources: source, invoke: async () => ({ content: "```json\n{}\n```", model: "cheap" }) })).rejects.toMatchObject({ code: "invalid_digest" });
    await expect(compressRawLogs({ sources: source, invoke: async () => ({ content: JSON.stringify({ summary: `sk-${"q".repeat(24)}` }), model: "cheap" }) })).rejects.toMatchObject({ code: "unsafe_output" });
  });

  it("rejects recursion using the same compression invoker", async () => {
    const sources = [{ ref: "x.log", content: "failed" }];
    const invoke: LogCompressionInvoker = async () => {
      await compressRawLogs({ sources, invoke });
      throw new Error("unreachable");
    };
    await expect(compressRawLogs({ sources, invoke })).rejects.toMatchObject({ code: "recursive_compression", blocksDownstream: true });
  });

  it("rejects empty, duplicate, and invalid source references before provider invocation", async () => {
    const invoke = vi.fn<LogCompressionInvoker>();
    await expect(compressRawLogs({ sources: [], invoke })).rejects.toMatchObject({ code: "empty_sources" });
    await expect(compressRawLogs({ sources: [{ ref: "a", content: "1" }, { ref: "a", content: "2" }], invoke })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(compressRawLogs({ sources: [{ ref: "bad\nref", content: "1" }], invoke })).rejects.toMatchObject({ code: "invalid_source" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("prepares deterministic source metadata while retaining only sanitized bounded chunks", () => {
    const first = prepareRawLogDigest([{ ref: "x", content: "Bearer very-secret-token-value\nboom" }]);
    const second = prepareRawLogDigest([{ ref: "x", content: "Bearer very-secret-token-value\nboom" }]);
    expect(first).toEqual(second);
    expect(first.chunks[0]!.text).toBe("Bearer [REDACTED]\nboom");
    expect(first.sources[0]).toMatchObject({ redactions: 1, truncated: false });
  });
});

function response(raw: RawLogDigestV1): { content: string; model: string; requestId: string } {
  return { content: JSON.stringify(digest(raw)), model: "z-ai/glm-4.7-flash", requestId: "req-1" };
}
function digest(raw: RawLogDigestV1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "log-digest",
    summary: "bounded failure summary",
    failureClass: "test.failure",
    diagnostics: ["assertion failed"],
    sources: raw.sources.map(({ redactions: _redactions, ...source }) => source),
  };
}
