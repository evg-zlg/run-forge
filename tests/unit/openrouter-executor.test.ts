import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterCapability, runOpenRouterAgent, validateOpenRouterDiff } from "../../src/implementation/openrouter-executor.js";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 2 } }), { status: 200 });
const diff = (path: string, added = "safe") => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${added}\n`;

afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENROUTER_API_KEY; });

describe("OpenRouter executor safety", () => {
  it("reports whitespace-only credentials as unavailable", () => {
    process.env.OPENROUTER_API_KEY = "  \t\n";
    expect(openRouterCapability()).toMatchObject({ status: "unavailable", limitations: ["openrouter_credentials_unavailable"] });
  });

  it("rejects forbidden, secret-bearing, and oversized diffs before apply", () => {
    expect(() => validateOpenRouterDiff(diff(".env"), { maxBytes: 1_000, maxChangedFiles: 2, forbiddenZones: [".env", "secrets"] })).toThrow("forbidden");
    expect(() => validateOpenRouterDiff(diff("src/config.ts", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456"), { maxBytes: 2_000, maxChangedFiles: 2, forbiddenZones: [] })).toThrow("secret scan failed");
    expect(() => validateOpenRouterDiff(diff("src/large.ts", "x".repeat(500)), { maxBytes: 100, maxChangedFiles: 2, forbiddenZones: [] })).toThrow("exceeds 100 bytes");
  });

  it("accounts maxCalls as global HTTP attempts across phase invocations", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(ok("planner one"))
      .mockResolvedValueOnce(ok("planner two"));
    vi.stubGlobal("fetch", fetchMock);
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-"));
    const previous: Array<Record<string, unknown>> = [];
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { execution: { maxPatchBytes: 10_000, maxChangedFiles: 10 }, providerRouting: { models: { planner: "test/model" }, maxCalls: 3, retry: { maxAttempts: 3 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { planner: 100 } } } } } as any;

    const first = await runOpenRouterAgent(request, artifactRoot, "plan", "planner", previous, "planner");
    expect(first.attempts).toBe(2);
    previous.push({ phase: "planner", tokenUsage: first.tokenUsage });
    const second = await runOpenRouterAgent(request, artifactRoot, "plan again", "planner", previous, "planner");
    expect(second.attempts).toBe(1);
    previous.push({ phase: "planner", tokenUsage: second.tokenUsage });
    await expect(runOpenRouterAgent(request, artifactRoot, "one too many", "planner", previous, "planner")).rejects.toThrow("openrouter_max_calls_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("persists only a bounded safe excerpt of provider output", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const raw = `API_KEY=sk-${"x".repeat(30)}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(raw)));
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-redaction-"));
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { execution: { maxPatchBytes: 10_000, maxChangedFiles: 10 }, providerRouting: { models: { planner: "test/model" }, maxCalls: 1, retry: { maxAttempts: 1 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { planner: 100 } } } } } as any;
    const result = await runOpenRouterAgent(request, artifactRoot, "plan", "planner", [], "planner");
    const persisted = await readFile(join(artifactRoot, result.stdoutArtifact), "utf8");
    expect(result.stdout).toContain("[redacted:");
    expect(persisted).not.toContain(raw);
  });
});
