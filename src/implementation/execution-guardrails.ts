import type { TaskExecutionMode } from "../product/task-spec-v2.js";
import type { ImplementationExecutorCapability, ImplementationExecutorRequest } from "./executor.js";

export type ProviderCapabilities = {
  maxInputContextTokens: number;
  maxOutputTokens: number;
  maxReasoningTokens: number;
  maxWallClockMs: number;
  maxCallsPerPhase: number;
  maxCostUsd: number | null;
  guarantees: { inputTokens: boolean; outputTokens: boolean; reasoningTokens: boolean; wallClock: boolean; calls: boolean; cost: boolean };
};

export type ExecutionEnvelope = {
  profile: string; classification: string; model: string | null; taskId: string; phase: "implementation" | "repair"; call: number;
  limits: { maxInputContextTokens: number; maxOutputTokens: number; maxReasoningTokens: number; maxWallClockMs: number; earlyProgressDeadlineMs: number; maxCallsPerPhase: number; maxPhaseTokens: number; maxTaskTokens: number; maxCostUsd: number | null };
  remaining: { phaseTokens: number; taskTokens: number; taskTimeMs: number; costUsd: number | null };
};

export type ProgressSignals = { filesInspected: string[]; filesChanged: string[]; exactDiagnosis: string | null; redTest: string | null; candidateDiff: string | null; partialPatch: string | null; tests: string[]; lastMeaningfulOutput: string | null; usage: { tokens: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; costUsd: number | null } };

export function configuredProviderCapabilities(executor: ImplementationExecutorCapability): ProviderCapabilities {
  let configured: Record<string, any> = {};
  try { configured = JSON.parse(process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES ?? "{}"); } catch { throw new Error("invalid_provider_capabilities_json"); }
  const guarantees = configured.guarantees ?? {};
  const command = splitCommand(executor.command ?? "")[0] ?? "";
  const directCodex = /(?:^|\/)codex$/.test(command);
  return {
    maxInputContextTokens: optionalPositive(configured.maxInputContextTokens) ?? executor.maxLimits.providerTokens,
    maxOutputTokens: optionalPositive(configured.maxOutputTokens) ?? executor.maxLimits.providerTokens,
    maxReasoningTokens: optionalPositive(configured.maxReasoningTokens) ?? executor.maxLimits.providerTokens,
    maxWallClockMs: optionalPositive(configured.maxWallClockMs) ?? executor.maxLimits.timeoutMs,
    maxCallsPerPhase: optionalPositive(configured.maxCallsPerPhase) ?? Math.max(1, executor.maxLimits.repairIterations + 1),
    maxCostUsd: optionalPositive(configured.maxCostUsd),
    guarantees: {
      inputTokens: !directCodex && guarantees.inputTokens === true,
      outputTokens: !directCodex && guarantees.outputTokens === true,
      reasoningTokens: !directCodex && guarantees.reasoningTokens === true,
      wallClock: guarantees.wallClock === true,
      calls: guarantees.calls === true,
      cost: !directCodex && guarantees.cost === true,
    },
  };
}

export function assertMandatoryProviderCaps(capability: ProviderCapabilities): void {
  const mandatory: Array<[keyof ProviderCapabilities["guarantees"], string]> = [["inputTokens", "input"], ["outputTokens", "output"], ["reasoningTokens", "reasoning"], ["wallClock", "wall-clock"], ["calls", "call"], ["cost", "cost"]];
  const missing = mandatory.filter(([key]) => !capability.guarantees[key]).map(([, name]) => name);
  if (missing.length) throw new Error(`provider_capability_rejected: mandatory ${missing.join(", ")} limits are not guaranteed`);
}

export function deriveExecutionEnvelope(request: ImplementationExecutorRequest, executor: ImplementationExecutorCapability, capability: ProviderCapabilities, phase: "implementation" | "repair", call: number, phaseTokens: number, taskTokens: number, taskTimeMs: number, remainingCostUsd: number | null): ExecutionEnvelope {
  const execution = request.spec.execution as unknown as Record<string, unknown>;
  const plan = execution.plan && typeof execution.plan === "object" ? execution.plan as Record<string, unknown> : {};
  const profile = normalizedPlanValue(plan, "profile");
  const classification = normalizedPlanValue(plan, "classification");
  const output = Math.min(optionalPositive(execution.maxOutputTokens) ?? phaseTokens, capability.maxOutputTokens, phaseTokens, taskTokens);
  const reasoning = Math.min(optionalPositive(execution.maxReasoningTokens) ?? output, capability.maxReasoningTokens, output);
  const maxWallClockMs = Math.min(request.spec.execution.timeoutMs, capability.maxWallClockMs, taskTimeMs);
  const taskSpecEarly = optionalPositive(execution.earlyProgressDeadlineMs) ?? maxWallClockMs;
  const testOverride = process.env.NODE_ENV === "test" || process.env.VITEST
    ? optionalPositive(process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS)
    : null;
  const earlyProgressDeadlineMs = Math.min(taskSpecEarly, testOverride ?? taskSpecEarly, maxWallClockMs);
  return { profile, classification, model: executor.model, taskId: request.spec.taskId, phase, call, limits: { maxInputContextTokens: Math.min(optionalPositive(execution.maxInputContextTokens) ?? request.spec.discovery.maxTokens, request.spec.discovery.maxTokens, capability.maxInputContextTokens), maxOutputTokens: output, maxReasoningTokens: reasoning, maxWallClockMs, earlyProgressDeadlineMs, maxCallsPerPhase: Math.min(optionalPositive(execution.maxCallsPerPhase) ?? 1, capability.maxCallsPerPhase), maxPhaseTokens: request.spec.execution.phaseBudgets[phase], maxTaskTokens: request.spec.execution.maxProviderTokens, maxCostUsd: remainingCostUsd === null ? null : Math.min(remainingCostUsd, capability.maxCostUsd ?? remainingCostUsd) }, remaining: { phaseTokens, taskTokens, taskTimeMs, costUsd: remainingCostUsd } };
}

function normalizedPlanValue(plan: Record<string, unknown>, key: "profile" | "classification"): string { const value = plan[key]; if (typeof value !== "string" || !value.length) throw new Error(`normalized_execution_plan_missing_${key}`); return value; }

export function optionalPositive(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }

export function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

export function totalProviderTokens(calls: Array<Record<string, unknown>>): number { return calls.reduce((sum, item) => sum + numeric(item.tokenUsage), 0); }

export function exactFileLineDiagnosis(message: string): boolean { return /(?:src|tests?|scripts|schemas|docs|config)\/[\w./-]+:\d+/.test(message) && /\b(?:diagnos|cause|fail(?:s|ed|ure)?|error|expected|actual)\b/i.test(message); }

export function pathsFromChanges(changes: unknown): string[] { return Array.isArray(changes) ? changes.flatMap((change) => change && typeof change === "object" && typeof (change as Record<string, unknown>).path === "string" ? [(change as Record<string, string>).path] : []) : []; }

export function commandInspectedPaths(item: Record<string, any>, command: string): string[] {
  const explicit = [item.file, item.path, ...(Array.isArray(item.files) ? item.files : [])].filter((path): path is string => typeof path === "string");
  if (!/(?:^|[\s'"/])(?:cat|sed|rg|grep|head|tail|less|bat)\b/.test(command)) return explicit;
  const fromCommand = command.match(/(?:src|tests?|scripts|schemas|docs|config)\/[A-Za-z0-9._/-]+/g) ?? [];
  return [...new Set([...explicit, ...fromCommand])];
}

export function usageFromEvent(item: Record<string, any>): ProgressSignals["usage"] { const usage = item.usage ?? item.token_usage ?? item.item?.usage; if (!usage) return { tokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null }; const input = usage.input_tokens ?? usage.inputTokens, cached = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0, output = usage.output_tokens ?? usage.outputTokens, reasoning = usage.reasoning_tokens ?? usage.reasoningTokens; const explicit = usage.total_tokens ?? usage.totalTokens ?? item.total_tokens; const tokens = Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached) ? Math.max(0, Number(input) - Number(cached)) + Number(output) : Number.isFinite(explicit) ? Number(explicit) : null; const cost = usage.cost_usd ?? usage.costUsd ?? item.cost_usd; return { tokens, inputTokens: Number.isFinite(input) ? Math.max(0, Number(input) - Number(cached)) : null, outputTokens: Number.isFinite(output) ? Number(output) : null, reasoningTokens: Number.isFinite(reasoning) ? Number(reasoning) : null, costUsd: Number.isFinite(cost) ? Number(cost) : null }; }

export function extractTokenUsage(stdout: string): number | null { const values = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const usage = item.usage ?? item.token_usage ?? item.item?.usage; const input = usage?.input_tokens ?? usage?.inputTokens, cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0, output = usage?.output_tokens ?? usage?.outputTokens; if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached)) return [Math.max(0, Number(input) - Number(cached)) + Number(output)]; const explicit = usage?.total_tokens ?? usage?.totalTokens ?? item.total_tokens; return Number.isFinite(explicit) ? [Number(explicit)] : []; } catch { return []; } }); return values.length ? Math.max(...values) : null; }

export function extractSummary(stdout: string, stderr: string): string { const finals = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const text = item.msg?.message ?? item.message ?? item.text ?? item.item?.text; return typeof text === "string" ? [text] : []; } catch { return []; } }); return (finals.at(-1) ?? stdout ?? stderr).slice(-20_000); }

function splitCommand(value: string): string[] { return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")) ?? []; }
