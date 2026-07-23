import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogCompressionInvoker, LogDigestV1, RawLogSourceV1 } from "./raw-log-compressor.js";
import { compressRawLogs } from "./raw-log-compressor.js";
import { runOpenRouterAgent } from "./openrouter-executor.js";
import type { ImplementationExecutorRequest } from "./executor.js";

/** The minimal common shape used by every validation executor at the raw-log boundary. */
export type ValidationRawLogEvidence = {
  artifactPath: string;
  outcome: string;
  stdout: string;
  stderr: string;
  /** A caller may explicitly classify otherwise-successful output as noisy. */
  rawLogRequiresCompression?: boolean;
};

/**
 * Failed output and explicitly noisy output must be reduced by logCompression
 * before any semantic provider sees validation evidence. Successful normal
 * output deliberately remains local and is omitted from provider context.
 */
export function validationRawLogSources<T extends ValidationRawLogEvidence>(validations: readonly T[]): RawLogSourceV1[] {
  return validations.filter((item) => item.outcome !== "passed" || item.rawLogRequiresCompression === true).flatMap((item) => [
    ...(item.stdout ? [{ ref: `${item.artifactPath}#stdout`, content: item.stdout }] : []),
    ...(item.stderr ? [{ ref: `${item.artifactPath}#stderr`, content: item.stderr }] : []),
  ]);
}

export async function gateValidationRawLogs(input: {
  validations: readonly ValidationRawLogEvidence[];
  artifactRoot: string;
  iteration: number;
  compress: (sources: RawLogSourceV1[], label: string) => Promise<{ digest: LogDigestV1; ref: string }>;
}): Promise<{ digest?: LogDigestV1; ref?: string; blocked: boolean }> {
  const sources = validationRawLogSources(input.validations);
  if (!sources.length) return { blocked: false };
  try {
    const compressed = await input.compress(sources, `validation-${input.iteration}`);
    return { ...compressed, blocked: false };
  } catch {
    await mkdir(join(input.artifactRoot, "validation", `iteration-${input.iteration}`), { recursive: true });
    await writeFile(join(input.artifactRoot, "validation", `iteration-${input.iteration}`, "log-digest-error.json"), JSON.stringify({ kind: "raw_log_compression_required", blocksDownstream: true, sources: sources.map((source) => source.ref) }, null, 2) + "\n", "utf8");
    return { blocked: true };
  }
}

export function repairDigestContext(iteration: number, ref?: string, digest?: LogDigestV1): string {
  if (!iteration) return "";
  if (!digest) return "Repair rawLogState=none. Raw stdout/stderr are never available in this prompt.";
  return `Validated repair log digest (rawLogState=compressed; ref=${ref ?? "missing"}):\n${JSON.stringify({ summary: digest.summary, failureClass: digest.failureClass, diagnostics: digest.diagnostics })}`;
}

export async function requireRawLogDigest(request: ImplementationExecutorRequest, cwd: string, providerCalls: Array<Record<string, unknown>>, sources: RawLogSourceV1[], label: string): Promise<{ digest: LogDigestV1; ref: string }> {
  const openRouterInvoker: LogCompressionInvoker = async (input) => {
    if (request.spec.providerRouting.provider !== "openrouter") throw new Error("raw_log_compression_requires_configured_invoker");
    const call = await runOpenRouterAgent(request, cwd, input.prompt, "logCompression", providerCalls, `log-compression-${label}`);
    const model = call.model;
    providerCalls.push({ command: "openrouter-coding-agent", purpose: "raw-log-compression", phase: "logCompression", requestId: call.requestId, costUsd: call.costUsd, attempts: call.attempts, cwd, executor: "openrouter-coding-agent", runtime: "local-disposable", executorId: "openrouter-coding-agent", model, providerCalls: true, networkAuthorized: true, usageAccounting: "provider", iteration: label, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, exitCode: call.exitCode, signal: call.signal, timedOut: call.timedOut, stdout: call.stdout, stderr: call.stderr, truncation: call.truncation, artifactPaths: [call.stdoutArtifact, call.stderrArtifact], failureReason: call.failureReason, classification: call.exitCode === 0 ? null : "provider", tokenUsage: call.tokenUsage, inputTokens: call.inputTokens, outputTokens: call.outputTokens, reasoningTokens: call.reasoningTokens, tokenBudget: request.spec.providerRouting.tokenBudget.perPhase.logCompression, stdoutArtifact: call.stdoutArtifact, stderrArtifact: call.stderrArtifact });
    if (call.exitCode !== 0) throw new Error(call.failureReason ?? "log_compression_provider_failed");
    return { content: call.stdout, model: model ?? "", requestId: call.requestId, tokenUsage: call.tokenUsage, inputTokens: call.inputTokens, outputTokens: call.outputTokens, reasoningTokens: call.reasoningTokens, costUsd: call.costUsd, attempts: call.attempts };
  };
  const invoke: LogCompressionInvoker = request.logCompressionInvoker ? async (input) => {
    const started = Date.now(), response = await request.logCompressionInvoker!(input), tokenUsage = response.tokenUsage ?? null;
    providerCalls.push({ command: "configured-log-compressor", purpose: "raw-log-compression", phase: "logCompression", requestId: response.requestId ?? null, costUsd: response.costUsd ?? null, attempts: response.attempts ?? 1, cwd, executor: "configured-log-compressor", runtime: "local-disposable", executorId: "configured-log-compressor", model: response.model, providerCalls: true, networkAuthorized: true, usageAccounting: tokenUsage === null ? "unavailable" : "provider", iteration: label, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: 0, timedOut: false, stdout: "[structured log digest]", stderr: "", artifactPaths: [], failureReason: null, classification: null, tokenUsage, inputTokens: response.inputTokens ?? null, outputTokens: response.outputTokens ?? null, reasoningTokens: response.reasoningTokens ?? null, tokenBudget: request.spec.providerRouting.tokenBudget.perPhase.logCompression });
    return response;
  } : openRouterInvoker;
  const result = await compressRawLogs({ sources, invoke });
  const ref = `provider/log-digest-${label}.json`;
  await writeFile(join(request.artifactRoot, ref), JSON.stringify({ digest: result.digest, rawDigestMetadata: result.rawDigestMetadata, model: result.model, requestId: result.requestId }, null, 2) + "\n", "utf8");
  return { digest: result.digest, ref };
}
