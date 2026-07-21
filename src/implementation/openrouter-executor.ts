import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import { implementationExecutorContract } from "../product/task-spec-contract.js";
import { executeOpenRouterChatCompletion, OpenRouterExecutionError } from "../providers/openrouter-execution-provider.js";
import { scanSecrets } from "../security/secret-scan.js";
import type { ImplementationExecutorCapability, ImplementationExecutorRequest } from "./executor.js";

export type OpenRouterPhase = "planner" | "implementer" | "repair" | "reviewer";
export type OpenRouterRun = { startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null; summary: string; cancelled: boolean; timedOut: boolean; stdout: string; stderr: string; truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; failureReason: string | null; tokenUsage: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; stdoutArtifact: string; stderrArtifact: string; requestId: string | null; costUsd: number | null; attempts: number };
type Selection = { selected: ImplementationExecutorCapability | null; reason: string; rejected: Array<{ id: string; reason: string }> };
const attemptAccounting = new WeakMap<Array<Record<string, unknown>>, number>();
const safeExcerptBytes = 16_384;

export function openRouterCapability(): ImplementationExecutorCapability {
  const ready = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return { id: "openrouter-coding-agent", status: ready ? "ready" : "unavailable", supports: [...implementationExecutorContract.modes], providerCalls: true, runtime: [...implementationExecutorContract.runtimes], providerRequirements: ["OPENROUTER_API_KEY"], networkRequirements: ["OpenRouter HTTPS transport"], maxLimits: implementationExecutorContract.maxLimits, limitations: ready ? [] : ["openrouter_credentials_unavailable"], command: null, model: null };
}
export function selectOpenRouterExecutor(spec: TaskSpecV2): Selection {
  const rejected = [{ id: implementationExecutorContract.id, reason: "providerRouting explicitly selected openrouter; local Codex fallback is prohibited." }];
  const capability = openRouterCapability();
  if (capability.status !== "ready") return { selected: null, reason: "openrouter_credentials_unavailable", rejected };
  const required: OpenRouterPhase[] = ["planner", "implementer", "reviewer"];
  if (spec.execution.maxRepairIterations > 0) required.push("repair");
  const missing = required.filter((phase) => !spec.providerRouting.models[phase]);
  if (missing.length) return { selected: null, reason: `openrouter_model_unavailable: missing ${missing.join(", ")} model`, rejected };
  if (!spec.authority.allowProviderCalls || !spec.authority.allowNetwork || spec.runtime.externalNetwork !== "allowed") return { selected: null, reason: "openrouter_network_or_authority_unavailable", rejected };
  capability.model = spec.providerRouting.models.implementer ?? null;
  return { selected: capability, reason: "Explicit providerRouting selected OpenRouter.", rejected };
}
export async function runOpenRouterAgent(request: ImplementationExecutorRequest, cwd: string, prompt: string, phase: OpenRouterPhase, previous: Array<Record<string, unknown>>, iteration: number | "planner" | "semantic-review"): Promise<OpenRouterRun> {
  const routing = request.spec.providerRouting, phaseUsed = previous.filter((call) => call.phase === phase).reduce((n, call) => n + (typeof call.tokenUsage === "number" ? call.tokenUsage : 0), 0), totalUsed = previous.reduce((n, call) => n + (typeof call.tokenUsage === "number" ? call.tokenUsage : 0), 0), costUsed = previous.reduce((n, call) => n + (typeof call.costUsd === "number" ? call.costUsd : 0), 0);
  const usedAttempts = attemptAccounting.get(previous) ?? previous.reduce((total, call) => total + (typeof call.attempts === "number" ? call.attempts : 1), 0);
  const remainingAttempts = routing.maxCalls - usedAttempts;
  if (remainingAttempts <= 0) throw new Error("openrouter_max_calls_exceeded");
  const phaseTokensRemaining = routing.tokenBudget.perPhase[phase] - phaseUsed, totalTokensRemaining = routing.tokenBudget.total - totalUsed;
  if (phaseTokensRemaining <= 0 || totalTokensRemaining <= 0) throw new Error("openrouter_token_budget_exceeded");
  if (routing.costBudgetUsd !== undefined && costUsed >= routing.costBudgetUsd) throw new Error("openrouter_cost_budget_exceeded");
  const started = Date.now(), startedAt = new Date(started).toISOString(), stdoutArtifact = `provider/iteration-${iteration}.stdout.log`, stderrArtifact = `provider/iteration-${iteration}.stderr.log`;
  let attempts = 0;
  let response: Awaited<ReturnType<typeof executeOpenRouterChatCompletion>> | null = null;
  await mkdir(join(request.artifactRoot, "provider"), { recursive: true });
  try {
    const reasoning = phase === "planner" || phase === "reviewer" ? routing.reasoning?.[phase] : undefined;
    response = await executeOpenRouterChatCompletion({ model: routing.models[phase]!, messages: [{ role: "system", content: phase === "planner" || phase === "reviewer" ? "Return concise structured implementation analysis only." : "Return only a raw unified git diff whose first non-whitespace line starts with diff --git a/. Never use Markdown fences, prose, or *** Begin Patch format. Do not include secrets, commits, or publication actions." }, { role: "user", content: prompt }], timeoutMs: routing.timeoutMs, maxCalls: Math.min(routing.retry.maxAttempts, remainingAttempts), maxTokens: Math.min(phaseTokensRemaining, totalTokensRemaining), reasoning, signal: request.signal });
    attempts = response.attempts; attemptAccounting.set(previous, usedAttempts + attempts);
    const rawOutput = response.content;
    if (Buffer.byteLength(rawOutput) > request.spec.execution.maxPatchBytes) throw new Error(`openrouter_response_too_large: exceeds ${request.spec.execution.maxPatchBytes} bytes`);
    const applicableOutput = phase === "implementer" || phase === "repair" ? normalizeOpenRouterDiff(rawOutput) : rawOutput;
    if ((phase === "implementer" || phase === "repair") && rawOutput.trim()) {
      validateOpenRouterDiff(applicableOutput, { maxBytes: request.spec.execution.maxPatchBytes, maxChangedFiles: request.spec.execution.maxChangedFiles, forbiddenZones: request.forbiddenZones, allowedWriteScopes: request.spec.discovery?.writeScopes });
      await applyDiff(cwd, applicableOutput);
    }
    const output = safeProviderExcerpt(applicableOutput);
    await writeFile(join(request.artifactRoot, stdoutArtifact), output); await writeFile(join(request.artifactRoot, stderrArtifact), "");
    const tokenUsage = response.usage.totalTokens ?? ((response.usage.inputTokens ?? 0) - (response.usage.cachedInputTokens ?? 0) + (response.usage.outputTokens ?? 0));
    return { startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: 0, signal: null, summary: output, cancelled: false, timedOut: false, stdout: output, stderr: "", truncation: { stdout: Buffer.byteLength(rawOutput) > Buffer.byteLength(output), stderr: false, limitBytes: safeExcerptBytes }, failureReason: null, tokenUsage, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reasoningTokens: response.usage.reasoningTokens, stdoutArtifact, stderrArtifact, requestId: response.requestId, costUsd: response.usage.costUsd, attempts };
  } catch (error) {
    const failure = error instanceof OpenRouterExecutionError ? error : null;
    attempts = Math.max(attempts, response?.attempts ?? failure?.options.attempts ?? 0);
    if (attempts) attemptAccounting.set(previous, usedAttempts + attempts);
    const reason = failure?.code === "missing_credential" ? "openrouter_credentials_unavailable" : failure?.code === "cancelled" ? "cancelled" : failure?.code === "timeout" ? "OpenRouter provider timed out." : redact(error instanceof Error ? error.message : "OpenRouter provider failed.");
    const rawFailureContent = failure?.options.content;
    const rawOutput = response?.content ?? (typeof rawFailureContent === "string" ? rawFailureContent : "");
    const output = safeProviderExcerpt(rawOutput);
    await writeFile(join(request.artifactRoot, stdoutArtifact), output);
    await writeFile(join(request.artifactRoot, stderrArtifact), reason);
    const usage = response?.usage ?? failure?.options.usage;
    const tokenUsage = usage ? usage.totalTokens ?? ((usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)) : null;
    return { startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: 1, signal: null, summary: output, cancelled: failure?.code === "cancelled", timedOut: failure?.code === "timeout", stdout: output, stderr: reason, truncation: { stdout: Buffer.byteLength(rawOutput) > Buffer.byteLength(output), stderr: false, limitBytes: safeExcerptBytes }, failureReason: reason, tokenUsage, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, stdoutArtifact, stderrArtifact, requestId: response?.requestId ?? failure?.options.requestId ?? null, costUsd: usage?.costUsd ?? null, attempts };
  }
}

export function normalizeOpenRouterDiff(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (candidate && !candidate.startsWith("diff --git ")) throw new Error("openrouter_patch_rejected: response must contain only a unified git diff");
  if (/^\*\*\* (?:Begin Patch|End Patch|Add File:|Update File:|Delete File:)/m.test(candidate)) throw new Error("openrouter_patch_rejected: response contains a patch service marker");
  const normalized = candidate.trimEnd()
    .replace(/^diff --git (?!a\/)(\S+) (?!b\/)(\S+)$/gm, "diff --git a/$1 b/$2")
    .replace(/^--- (?!a\/|\/dev\/null)(\S+)$/gm, "--- a/$1")
    .replace(/^\+\+\+ (?!b\/|\/dev\/null)(\S+)$/gm, "+++ b/$1");
  return normalizeNewFileBody(normalized) + "\n";
}

export function validateOpenRouterDiff(diff: string, limits: { maxBytes: number; maxChangedFiles: number; forbiddenZones: string[]; allowedWriteScopes?: string[] }): string[] {
  if (Buffer.byteLength(diff) > limits.maxBytes) throw new Error(`openrouter_patch_rejected: patch exceeds ${limits.maxBytes} bytes`);
  if (diff.includes("\0")) throw new Error("openrouter_patch_rejected: patch contains a NUL byte");
  const files = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].flatMap((match) => [match[1]!, match[2]!]);
  const uniqueFiles = [...new Set(files)];
  if (!uniqueFiles.length) throw new Error("openrouter_patch_rejected: response is not a unified git diff");
  if (uniqueFiles.length > limits.maxChangedFiles) throw new Error(`openrouter_patch_rejected: changed files exceed limit ${limits.maxChangedFiles}`);
  const zones = limits.forbiddenZones.map(normalizePatchPath).filter(Boolean);
  for (const rawFile of uniqueFiles) {
    const file = normalizePatchPath(rawFile);
    if (!file || file.startsWith("../") || file.startsWith("/") || file.split("/").includes("..")) throw new Error(`openrouter_patch_rejected: path escapes workspace`);
    if (zones.some((zone) => file === zone || file.startsWith(`${zone}/`))) throw new Error(`openrouter_patch_rejected: changed path is forbidden: ${file}`);
    if (limits.allowedWriteScopes !== undefined && !limits.allowedWriteScopes.some((scope) => scopeContains(normalizePatchPath(scope), file))) throw new Error(`openrouter_patch_rejected: changed path is outside allowed write scopes: ${file}`);
  }
  if (scanSecrets(addedPatchLines(diff)).status === "failed") throw new Error("openrouter_patch_rejected: secret scan failed");
  return uniqueFiles;
}

async function applyDiff(cwd: string, diff: string): Promise<void> { await new Promise<void>((ok, fail) => { const child = spawn("git", ["apply", "--recount", "--whitespace=nowarn", "-"], { cwd, stdio: ["pipe", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", fail); child.on("close", (code) => code === 0 ? ok() : fail(new Error(`openrouter_patch_apply_failed: ${redact(stderr).slice(0, 500)}`))); child.stdin.end(diff); }); }
function redact(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
function safeProviderExcerpt(value: string): string { if (scanSecrets(value).status === "failed") return "[redacted: provider output contained secret-like content]"; const redacted = redact(value); return Buffer.byteLength(redacted) <= safeExcerptBytes ? redacted : `${Buffer.from(redacted).subarray(0, safeExcerptBytes).toString("utf8")}\n[truncated provider output]`; }
function normalizePatchPath(value: string): string { return value.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""); }
function scopeContains(scope: string, path: string): boolean { return Boolean(scope) && (path === scope || path.startsWith(`${scope}/`)); }
function addedPatchLines(diff: string): string { return diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n"); }
function normalizeNewFileBody(diff: string): string { const lines = diff.split(/\r?\n/); let newFile = false, hunk = false; return lines.map((line) => { if (line.startsWith("diff --git ")) { newFile = false; hunk = false; return line; } if (line === "--- /dev/null") { newFile = true; return line; } if (line.startsWith("@@ ")) { hunk = true; return line; } if (newFile && hunk && !line.startsWith("+") && !line.startsWith("\\ No newline")) return `+${line}`; return line; }).join("\n"); }
