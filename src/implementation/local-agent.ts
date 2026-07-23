import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEnvelope, ProgressSignals } from "./execution-guardrails.js";

export type LocalRun = {
  startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null;
  summary: string; cancelled: boolean; timedOut: boolean; noProgress: boolean; stdout: string; stderr: string;
  truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; failureReason: string | null;
  tokenUsage: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
  costUsd: number | null; progressSignals: ProgressSignals; stdoutArtifact: string; stderrArtifact: string;
};

export type LocalAgentOptions = {
  /** The precomputed, bounded execution contract passed to the provider verbatim. */
  envelope?: ExecutionEnvelope;
  /** Durable checkpoint hook; it receives only structured/redacted progress metadata. */
  onUsefulProgress?: (signals: ProgressSignals) => void | Promise<void>;
  /** Review prose is meaningful evidence but not an implementation progress signal. */
  enforceEarlyProgress?: boolean;
};

/**
 * Runs a local provider with a bounded environment.  Provider output is persisted as a
 * redacted artifact; callers should expose only the artifact paths and structured receipt.
 */
export async function runLocalAgent(
  commandText: string, model: string | null, cwd: string, prompt: string, timeoutMs: number,
  signal: AbortSignal | undefined, root: string, iteration: number | "semantic-review", options: LocalAgentOptions = {},
): Promise<LocalRun> {
  const argv = split(commandText);
  const command = argv.shift();
  if (!command) throw new Error("implementation_executor_command_empty");
  const isCodex = /(?:^|\/)codex$/.test(command);
  const args = isCodex
    ? [...argv, "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", cwd, ...(model ? ["--model", model] : []), prompt]
    : argv;
  const envelope = options.envelope ?? fallbackEnvelope(timeoutMs, model, iteration);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let stdout = "", stderr = "", timedOut = false, cancelled = false, noProgress = false, pendingLine = "";
  const signals = initialSignals();
  let progressWork = Promise.resolve();
  let useful = false;
  const stdoutArtifact = `provider/iteration-${iteration}.stdout.log`;
  const stderrArtifact = `provider/iteration-${iteration}.stderr.log`;
  await mkdir(join(root, "provider"), { recursive: true });

  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [isCodex ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        ...safeEnv(),
        RUNFORGE_IMPLEMENTATION_REQUEST: join(root, "task-spec.normalized.json"),
        RUNFORGE_IMPLEMENTATION_PROMPT: prompt,
        RUNFORGE_EXECUTION_ENVELOPE: JSON.stringify(envelope),
        RUNFORGE_NETWORK_POLICY: "provider-only",
      },
    });
    if (!isCodex) child.stdin?.end(prompt);
    const stop = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, envelope.limits.maxWallClockMs);
    const earlyLimit = envelope.limits.earlyProgressDeadlineMs;
    // The provider process must be able to start and emit its first JSON event.
    // Keep very small caller limits useful without treating process startup as silence.
    const earlyDeadlineMs = Math.min(envelope.limits.maxWallClockMs, Math.max(earlyLimit, 100));
    const earlyTimer = options.enforceEarlyProgress === false ? undefined : setTimeout(() => {
      if (!useful) { noProgress = true; terminate(); }
    }, earlyDeadlineMs);
    const consume = (line: string) => {
      if (!line.trim()) return;
      let item: Record<string, any>;
      try { item = JSON.parse(line) as Record<string, any>; } catch { return; }
      updateSignals(signals, item);
      const isUseful = Boolean(
        signals.filesInspected.length || signals.filesChanged.length || signals.exactDiagnosis || signals.redTest ||
        signals.candidateDiff || signals.partialPatch || signals.tests.length,
      );
      if (!isUseful) return;
      useful = true;
      if (earlyTimer) clearTimeout(earlyTimer);
      progressWork = progressWork.then(() => options.onUsefulProgress?.(structuredClone(signals)));
    };
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (Buffer.byteLength(stdout) < 2_000_000) stdout += text;
      const lines = (pendingLine + text).split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr?.on("data", (chunk) => { if (Buffer.byteLength(stderr) < 2_000_000) stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); if (earlyTimer) clearTimeout(earlyTimer); signal?.removeEventListener("abort", stop); reject(error); });
    child.on("close", (exitCode, childSignal) => {
      clearTimeout(timer); if (earlyTimer) clearTimeout(earlyTimer);
      if (pendingLine) consume(pendingLine);
      signal?.removeEventListener("abort", stop);
      const safeStdout = redact(stdout);
      const safeStderr = redact(stderr);
      const normalizedExit = timedOut || noProgress ? null : exitCode;
      const failureReason = normalizedExit === 0 ? null
        : noProgress ? `no_progress: no useful provider signal before ${earlyDeadlineMs}ms.`
          : timedOut ? `Implementation provider timed out after ${envelope.limits.maxWallClockMs}ms.`
            : cancelled ? "Implementation provider was cancelled."
              : safeStdout.trim() || safeStderr.trim() ? `Implementation provider exited with code ${normalizedExit ?? "signal"}.`
                : "Implementation provider exited non-zero without stdout or stderr.";
      void progressWork.then(async () => {
        await Promise.all([writeFile(join(root, stdoutArtifact), safeStdout), writeFile(join(root, stderrArtifact), safeStderr)]);
        resolveRun({
          startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: normalizedExit,
          signal: childSignal, summary: summary(safeStdout, safeStderr), cancelled, timedOut, noProgress,
          stdout: safeStdout, stderr: safeStderr,
          truncation: { stdout: Buffer.byteLength(stdout) >= 2_000_000, stderr: Buffer.byteLength(stderr) >= 2_000_000, limitBytes: 2_000_000 },
          failureReason, tokenUsage: signals.usage.tokens ?? extractTokenUsage(safeStdout), inputTokens: signals.usage.inputTokens,
          outputTokens: signals.usage.outputTokens, reasoningTokens: signals.usage.reasoningTokens, costUsd: signals.usage.costUsd,
          progressSignals: signals, stdoutArtifact, stderrArtifact,
        });
      }).catch(reject);
    });
  });
}

function fallbackEnvelope(timeoutMs: number, model: string | null, iteration: number | "semantic-review"): ExecutionEnvelope {
  const limit = Math.max(1, timeoutMs);
  return {
    profile: "legacy", classification: "legacy", model, taskId: "unknown", phase: iteration === 0 ? "implementation" : "repair", call: 1,
    limits: { maxInputContextTokens: 1, maxOutputTokens: 1, maxReasoningTokens: 1, maxWallClockMs: limit, earlyProgressDeadlineMs: limit, maxCallsPerPhase: 1, maxPhaseTokens: 1, maxTaskTokens: 1, maxCostUsd: null },
    remaining: { phaseTokens: 1, taskTokens: 1, taskTimeMs: limit, costUsd: null },
  };
}

function initialSignals(): ProgressSignals {
  return { filesInspected: [], filesChanged: [], exactDiagnosis: null, redTest: null, candidateDiff: null, partialPatch: null, tests: [], lastMeaningfulOutput: null, usage: { tokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null } };
}

function updateSignals(signals: ProgressSignals, item: Record<string, any>): void {
  const nested = item.item && typeof item.item === "object" ? item.item as Record<string, any> : {};
  const type = `${String(item.type ?? item.event ?? "")} ${String(nested.type ?? "")}`.trim().toLowerCase();
  const message = String(item.msg?.message ?? item.message ?? item.text ?? nested.text ?? nested.aggregated_output ?? "");
  const file = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : typeof nested.file === "string" ? nested.file : typeof nested.path === "string" ? nested.path : null;
  const changes = [
    ...(Array.isArray(item.changes) ? item.changes : []),
    ...(Array.isArray(nested.changes) ? nested.changes : []),
  ].flatMap((change) => change && typeof change.path === "string" ? [change.path] : []);
  if (file && /inspect|read/.test(type)) add(signals.filesInspected, file);
  for (const path of changes) add(signals.filesChanged, path);
  if (file && /(?:file[_ .-]?change|candidate[_ .-]?(?:diff|change)|partial[_ .-]?patch)/.test(type)) add(signals.filesChanged, file);
  if ((file && Number.isFinite(item.line) && /diagnos|root.?cause|exact/.test(`${type} ${message}`)) || /(?:src|tests?)\/[\w./-]+:\d+.*(?:diagnos|cause|fails?)/i.test(message)) signals.exactDiagnosis = message || `${file}:${item.line}`;
  const redStatus = item.status === "red" || nested.status === "red" || nested.exit_code === 1 || item.exit_code === 1;
  if (redStatus && /(?:test|red|fail|command_execution)/.test(`${type} ${message}`.toLowerCase())) signals.redTest = message || `${file ?? "test"}:${item.line ?? "?"}`;
  if (/(?:candidate[_ .-]?(?:diff|change)|file_change)/.test(`${type} ${message}`.toLowerCase()) || changes.length) signals.candidateDiff = changes[0] ?? (message || file || type);
  if (/partial[_ .-]?patch/.test(`${type} ${message}`.toLowerCase())) signals.partialPatch = message || file || type;
  const command = typeof item.command === "string" ? item.command : typeof nested.command === "string" ? nested.command : null;
  if ((/test|command_execution/.test(type) && (message || command))) add(signals.tests, command ?? message);
  const usage = usageFromEvent(item);
  for (const key of ["tokens", "inputTokens", "outputTokens", "reasoningTokens", "costUsd"] as const) if (usage[key] !== null) signals.usage[key] = Math.max(signals.usage[key] ?? 0, usage[key]!);
  if (message) signals.lastMeaningfulOutput = message.slice(0, 2_000);
}

function add(values: string[], value: string): void { if (!values.includes(value)) values.push(value); }

function usageFromEvent(item: Record<string, any>): ProgressSignals["usage"] {
  const usage = item.usage ?? item.token_usage ?? item.item?.usage;
  if (!usage) return { tokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null };
  const input = usage.input_tokens ?? usage.inputTokens;
  const cached = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0;
  const output = usage.output_tokens ?? usage.outputTokens;
  const reasoning = usage.reasoning_tokens ?? usage.reasoningTokens;
  const explicit = usage.total_tokens ?? usage.totalTokens ?? item.total_tokens;
  const tokens = Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached) ? Math.max(0, Number(input) - Number(cached)) + Number(output) : Number.isFinite(explicit) ? Number(explicit) : null;
  const cost = usage.cost_usd ?? usage.costUsd ?? item.cost_usd;
  return { tokens, inputTokens: Number.isFinite(input) ? Math.max(0, Number(input) - Number(cached)) : null, outputTokens: Number.isFinite(output) ? Number(output) : null, reasoningTokens: Number.isFinite(reasoning) ? Number(reasoning) : null, costUsd: Number.isFinite(cost) ? Number(cost) : null };
}

export function extractTokenUsage(stdout: string): number | null {
  const values = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const item = JSON.parse(line) as Record<string, any>;
      const usage = item.usage ?? item.token_usage ?? item.item?.usage;
      const input = usage?.input_tokens ?? usage?.inputTokens;
      const cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0;
      const output = usage?.output_tokens ?? usage?.outputTokens;
      if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached)) return [Math.max(0, Number(input) - Number(cached)) + Number(output)];
      const explicit = usage?.total_tokens ?? usage?.totalTokens ?? item.total_tokens;
      return Number.isFinite(explicit) ? [Number(explicit)] : [];
    } catch { return []; }
  });
  return values.length ? Math.max(...values) : null;
}

function split(value: string): string[] { return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")) ?? []; }
function summary(stdout: string, stderr: string): string { const last = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const text = item.msg?.message ?? item.message ?? item.text ?? item.item?.text; return typeof text === "string" ? [text] : []; } catch { return []; } }).at(-1); return (last ?? stdout ?? stderr).slice(-20_000); }
function safeEnv(): NodeJS.ProcessEnv { const keys = ["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]; return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
function redact(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
