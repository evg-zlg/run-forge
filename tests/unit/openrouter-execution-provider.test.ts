import { afterEach, describe, expect, it, vi } from "vitest";
import { executeOpenRouterChatCompletion, openRouterExecutionReadiness, type OpenRouterExecutionRequest } from "../../src/providers/openrouter-execution-provider.js";

const request = (): OpenRouterExecutionRequest => ({ model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }], timeoutMs: 50, maxCalls: 1 });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const success = { id: "provider-request", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.00012, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } };

afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENROUTER_API_KEY; });

describe("OpenRouter execution provider", () => {
  it("is secret-free when reporting readiness", () => {
    process.env.OPENROUTER_API_KEY = "should-not-be-needed";
    expect(openRouterExecutionReadiness()).toEqual({ configured: true, endpoint: "https://openrouter.ai/api/v1" });
    expect(openRouterExecutionReadiness({ enabled: false })).toEqual({ configured: false, endpoint: null });
  });

  it("does not invoke fetch without a credential", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(executeOpenRouterChatCompletion(request())).rejects.toMatchObject({ code: "missing_credential" });
    process.env.OPENROUTER_API_KEY = " \t\n ";
    await expect(executeOpenRouterChatCompletion(request())).rejects.toMatchObject({ code: "missing_credential" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects endpoint overrides before a credential can be exfiltrated", async () => {
    process.env.OPENROUTER_API_KEY = "top-secret";
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(executeOpenRouterChatCompletion({ ...request(), endpoint: "https://attacker.example/api/v1" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(executeOpenRouterChatCompletion({ ...request(), endpoint: "https://openrouter.ai.evil.example/api/v1" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts chat completions and returns usage, cost and metadata", async () => {
    process.env.OPENROUTER_API_KEY = "top-secret";
    const fetchMock = vi.fn().mockResolvedValue(response(success, 200, { "x-request-id": "edge-id" })); vi.stubGlobal("fetch", fetchMock);
    await expect(executeOpenRouterChatCompletion(request())).resolves.toEqual({ content: "done", requestId: "edge-id", finishReason: "stop", attempts: 1, usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningTokens: 2, totalTokens: 14, costUsd: 0.00012 } });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer top-secret");
  });

  it("classifies malformed and authentication responses", async () => {
    process.env.OPENROUTER_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ choices: [] })).mockResolvedValueOnce(response({ error: "no" }, 401)));
    await expect(executeOpenRouterChatCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
    await expect(executeOpenRouterChatCompletion(request())).rejects.toMatchObject({ code: "authentication", options: { status: 401 } });
  });

  it("retries rate limits only within the caller's max calls", async () => {
    process.env.OPENROUTER_API_KEY = "secret";
    const fetchMock = vi.fn().mockResolvedValue(response({ error: "slow" }, 429)); vi.stubGlobal("fetch", fetchMock);
    await expect(executeOpenRouterChatCompletion({ ...request(), maxCalls: 2 })).rejects.toMatchObject({ code: "rate_limited", options: { attempts: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes timeout and caller cancellation", async () => {
    process.env.OPENROUTER_API_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))));
    await expect(executeOpenRouterChatCompletion({ ...request(), timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController(); controller.abort();
    await expect(executeOpenRouterChatCompletion({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never leaks credential text through errors", async () => {
    process.env.OPENROUTER_API_KEY = "super-secret-token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Bearer super-secret-token authorization=super-secret-token")));
    await expect(executeOpenRouterChatCompletion(request())).rejects.toMatchObject({ code: "network" });
    await executeOpenRouterChatCompletion(request()).catch((error: Error) => expect(error.message).not.toContain("super-secret-token"));
  });
});
