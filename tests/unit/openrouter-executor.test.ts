import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenRouterDiff, openRouterCapability, runOpenRouterAgent, validateOpenRouterDiff } from "../../src/implementation/openrouter-executor.js";

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

  it("rejects a campaign patch outside its explicit write scopes before mutating the workspace", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-scope-"));
    await writeFile(join(artifactRoot, "outside.txt"), "old\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(diff("outside.txt", "new"))));
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { discovery: { writeScopes: ["src"] }, execution: { maxPatchBytes: 10_000, maxChangedFiles: 2 }, providerRouting: { models: { implementer: "test/model" }, maxCalls: 1, retry: { maxAttempts: 1 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { implementer: 100 } } } } } as any;
    const result = await runOpenRouterAgent(request, artifactRoot, "implement", "implementer", [], 0);
    expect(result).toMatchObject({ exitCode: 1, failureReason: expect.stringContaining("outside allowed write scopes") });
    expect(await readFile(join(artifactRoot, "outside.txt"), "utf8")).toBe("old\n");
  });

  it("normalizes a single fenced unified diff", () => {
    expect(normalizeOpenRouterDiff(`\`\`\`diff\n${diff("src/value.ts")}\`\`\``)).toBe(diff("src/value.ts"));
  });

  it("rejects prose and patch service markers instead of folding them into a repaired new file", () => {
    const malformedNewFile = "diff --git a/guide.md b/guide.md\nnew file mode 100644\n--- /dev/null\n+++ b/guide.md\n@@ -0,0 +1,1 @@\nGuide\n";
    expect(() => normalizeOpenRouterDiff(`Here is the patch:\n${diff("src/value.ts")}`)).toThrow("must contain only a unified git diff");
    expect(() => normalizeOpenRouterDiff(`${malformedNewFile}*** End Patch\n`)).toThrow("patch service marker");
  });

  it("preserves provider usage when a successful response is rejected after receipt", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "not a diff" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.001 } }), { status: 200, headers: { "x-request-id": "request-1" } })));
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-accounting-"));
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { execution: { maxPatchBytes: 10_000, maxChangedFiles: 10 }, providerRouting: { models: { implementer: "test/model" }, maxCalls: 1, retry: { maxAttempts: 1 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { implementer: 100 } } } } } as any;
    const result = await runOpenRouterAgent(request, artifactRoot, "implement", "implementer", [], 0);
    expect(result).toMatchObject({ exitCode: 1, attempts: 1, requestId: "request-1", tokenUsage: 18, inputTokens: 11, outputTokens: 7, reasoningTokens: 3, costUsd: 0.001, stdout: "not a diff" });
    expect(await readFile(join(artifactRoot, result.stdoutArtifact), "utf8")).toBe("not a diff");
  });

  it("safely recounts otherwise valid model-generated hunk sizes before apply", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-recount-"));
    await writeFile(join(artifactRoot, "value.txt"), "old\n");
    const patch = "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1,1 +1,3 @@\n-old\n+new\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(patch)));
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { execution: { maxPatchBytes: 10_000, maxChangedFiles: 2 }, providerRouting: { models: { implementer: "test/model" }, maxCalls: 1, retry: { maxAttempts: 1 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { implementer: 100 } } } } } as any;
    const result = await runOpenRouterAgent(request, artifactRoot, "implement", "implementer", [], 0);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(artifactRoot, "value.txt"), "utf8")).toBe("new\n");
  });

  it("repairs missing addition markers only inside a declared new-file hunk", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const artifactRoot = await mkdtemp(join(tmpdir(), "runforge-openrouter-new-file-"));
    const patch = "diff --git a/guide.md b/guide.md\nnew file mode 100644\n--- /dev/null\n+++ b/guide.md\n@@ -0,0 +1,9 @@\n+# Guide\n\n## Topic\n\n- item\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(patch)));
    const request = { artifactRoot, signal: undefined, forbiddenZones: [], spec: { execution: { maxPatchBytes: 10_000, maxChangedFiles: 2 }, providerRouting: { models: { implementer: "test/model" }, maxCalls: 1, retry: { maxAttempts: 1 }, timeoutMs: 100, tokenBudget: { total: 100, perPhase: { implementer: 100 } } } } } as any;
    const result = await runOpenRouterAgent(request, artifactRoot, "implement", "implementer", [], 0);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(artifactRoot, "guide.md"), "utf8")).toBe("# Guide\n\n## Topic\n\n- item\n");
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
