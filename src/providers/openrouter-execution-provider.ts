/** A small, server-only OpenRouter chat-completions transport. It deliberately owns no credential state. */
export type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ReadonlyArray<{ type: string; text?: string }>;
  name?: string;
};

export type OpenRouterExecutionRequest = {
  model: string;
  messages: ReadonlyArray<OpenRouterChatMessage>;
  endpoint?: string;
  timeoutMs: number;
  /** Total HTTP attempts, including the first attempt. */
  maxCalls: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  headers?: Readonly<Record<string, string>>;
};

export type OpenRouterUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

export type OpenRouterExecutionResult = {
  content: string;
  usage: OpenRouterUsage;
  requestId: string | null;
  finishReason: string | null;
  attempts: number;
};

export type OpenRouterFailureCode = "missing_credential" | "invalid_request" | "authentication" | "rate_limited" | "timeout" | "cancelled" | "network" | "provider" | "malformed_response";

export class OpenRouterExecutionError extends Error {
  constructor(
    readonly code: OpenRouterFailureCode,
    message: string,
    readonly options: { status?: number; retryable?: boolean; attempts?: number } = {}
  ) {
    super(message);
    this.name = "OpenRouterExecutionError";
  }
}

export const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";

/** This readiness check is intentionally credential-free: deployment config must not read secrets. */
export function openRouterExecutionReadiness(config: { enabled?: boolean; endpoint?: string } = {}): { configured: boolean; endpoint: string | null } {
  if (config.enabled === false) return { configured: false, endpoint: null };
  try {
    return { configured: true, endpoint: safeEndpoint(config.endpoint) };
  } catch {
    return { configured: false, endpoint: null };
  }
}

export async function executeOpenRouterChatCompletion(request: OpenRouterExecutionRequest): Promise<OpenRouterExecutionResult> {
  validateRequest(request);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim(); // Read and normalize at invocation only; never retain or expose it.
  if (!apiKey) throw new OpenRouterExecutionError("missing_credential", "OpenRouter credential is unavailable.");
  const endpoint = safeEndpoint(request.endpoint);
  const url = `${endpoint}/chat/completions`;
  let latest: OpenRouterExecutionError | undefined;

  for (let attempt = 1; attempt <= request.maxCalls; attempt += 1) {
    try {
      return await callOnce(url, apiKey, request, attempt);
    } catch (error) {
      const failure = asFailure(error, apiKey, attempt);
      latest = failure;
      if (!failure.options.retryable || attempt === request.maxCalls) throw failure;
      if (request.retryDelayMs && request.retryDelayMs > 0) await delay(request.retryDelayMs, request.signal);
    }
  }
  throw latest ?? new OpenRouterExecutionError("provider", "OpenRouter request failed.");
}

async function callOnce(url: string, apiKey: string, request: OpenRouterExecutionRequest, attempts: number): Promise<OpenRouterExecutionResult> {
  if (request.signal?.aborted) throw new OpenRouterExecutionError("cancelled", "OpenRouter request was cancelled.", { attempts });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  const cancel = () => controller.abort();
  request.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...request.headers, authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: request.model, messages: request.messages, ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }) })
    });
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-openrouter-request-id");
    if (!response.ok) {
      const code: OpenRouterFailureCode = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limited" : "provider";
      throw new OpenRouterExecutionError(code, `OpenRouter request failed with status ${response.status}.`, { status: response.status, retryable: response.status === 429 || response.status >= 500, attempts });
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new OpenRouterExecutionError("malformed_response", "OpenRouter returned invalid JSON.", { attempts }); }
    return parseResponse(payload, requestId, attempts);
  } catch (error) {
    if (error instanceof OpenRouterExecutionError) throw error;
    if (request.signal?.aborted) throw new OpenRouterExecutionError("cancelled", "OpenRouter request was cancelled.", { attempts });
    if (controller.signal.aborted) throw new OpenRouterExecutionError("timeout", "OpenRouter request timed out.", { retryable: true, attempts });
    throw new OpenRouterExecutionError("network", "OpenRouter network request failed.", { retryable: true, attempts });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", cancel);
  }
}

function parseResponse(payload: unknown, requestId: string | null, attempts: number): OpenRouterExecutionResult {
  const record = object(payload); const choice = Array.isArray(record?.choices) ? object(record.choices[0]) : null;
  const message = object(choice?.message); const content = contentText(message?.content);
  if (!record || !choice || content === null) throw new OpenRouterExecutionError("malformed_response", "OpenRouter response did not contain assistant content.", { attempts });
  const usage = object(record.usage);
  const promptDetails = object(usage?.prompt_tokens_details); const completionDetails = object(usage?.completion_tokens_details);
  return { content, requestId: requestId ?? stringValue(record.id), finishReason: stringValue(choice.finish_reason), attempts, usage: {
    inputTokens: numberValue(usage?.prompt_tokens), cachedInputTokens: numberValue(promptDetails?.cached_tokens), outputTokens: numberValue(usage?.completion_tokens), reasoningTokens: numberValue(completionDetails?.reasoning_tokens), totalTokens: numberValue(usage?.total_tokens), costUsd: numberValue(usage?.cost) ?? numberValue(usage?.total_cost)
  } };
}

function safeEndpoint(value = DEFAULT_OPENROUTER_ENDPOINT): string {
  let url: URL; try { url = new URL(value); } catch { throw new OpenRouterExecutionError("invalid_request", "OpenRouter endpoint must be a valid HTTPS URL."); }
  const normalized = url.toString().replace(/\/$/, "");
  // The Authorization header may only ever be sent to the official API origin and base path.
  if (normalized !== DEFAULT_OPENROUTER_ENDPOINT) throw new OpenRouterExecutionError("invalid_request", "OpenRouter endpoint is not allowlisted.");
  return DEFAULT_OPENROUTER_ENDPOINT;
}

function validateRequest(request: OpenRouterExecutionRequest): void {
  if (!request.model || !request.messages.length || !Number.isInteger(request.maxCalls) || request.maxCalls < 1 || request.maxCalls > 20 || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000 || (request.retryDelayMs !== undefined && (!Number.isFinite(request.retryDelayMs) || request.retryDelayMs < 0 || request.retryDelayMs > 60_000))) throw new OpenRouterExecutionError("invalid_request", "OpenRouter request limits are invalid.");
}
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function contentText(value: unknown): string | null { if (typeof value === "string") return value; if (Array.isArray(value)) { const text = value.map((part) => object(part)?.type === "text" ? stringValue(object(part)?.text) ?? "" : "").join(""); return text || null; } return null; }
function asFailure(error: unknown, secret: string, attempts: number): OpenRouterExecutionError { if (error instanceof OpenRouterExecutionError) return new OpenRouterExecutionError(error.code, redact(error.message, secret), { ...error.options, attempts }); return new OpenRouterExecutionError("network", "OpenRouter network request failed.", { retryable: true, attempts }); }
function redact(value: string, secret: string): string { return value.replaceAll(secret, "[REDACTED]").replace(/Bearer\s+[^\s,]+/gi, "Bearer [REDACTED]").replace(/authorization\s*[:=]\s*[^\s,]+/gi, "authorization=[REDACTED]"); }
async function delay(ms: number, signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw new OpenRouterExecutionError("cancelled", "OpenRouter request was cancelled."); await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new OpenRouterExecutionError("cancelled", "OpenRouter request was cancelled.")); }, { once: true }); }); }
