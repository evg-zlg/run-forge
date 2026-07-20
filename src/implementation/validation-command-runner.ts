import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { classifyValidationExecution, type ValidationCommandOutcome, type ValidationPlanEntry } from "../validation/capability-contract.js";
import { executeGitEvidence, GitEvidenceCapabilityUnsupportedError, type GitEvidenceBinding } from "../validation/git-evidence-lane.js";

export type CommandDiagnostic = {
  command: string; cwd: string; startedAt: string; finishedAt: string; durationMs: number;
  executor: string; runtime: string; lane: string; argv: string[] | null;
  exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; setupFailure: boolean;
  truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; artifactPaths: string[];
  failureReason: string | null; classification: "product" | "setup" | "runtime" | "provider" | "infrastructure" | null;
  diagnosticGap: boolean; infrastructureDefect: string | null; artifactPath: string;
  outcome: ValidationCommandOutcome; acceptance: ValidationPlanEntry["acceptance"]; evidenceRole: string;
  requiredCapabilities: ValidationPlanEntry["requiredCapabilities"]; availableCapabilities: ValidationPlanEntry["availableCapabilities"]; missingCapabilities: ValidationPlanEntry["missingCapabilities"];
  repositoryIdentity: string | null; boundSha: string | null; safetyAssertions: string[];
};

export type ProductValidationExecution = {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean;
};

export async function runValidation(plan: ValidationPlanEntry, root: string, iteration: number, index: number, timeoutMs: number, signal?: AbortSignal, gitBinding?: GitEvidenceBinding, executeProduct?: (plan: ValidationPlanEntry, artifactDirectory: string) => Promise<ProductValidationExecution>): Promise<CommandDiagnostic> {
  const started = Date.now(), startedAt = new Date(started).toISOString();
  let stdout = "", stderr = "", timedOut = false, setupFailure = false, cancelled = false, capabilityUnsupported = false;
  const artifactPath = `validation/iteration-${iteration}/command-${index}.json`;
  await mkdir(dirname(join(root, artifactPath)), { recursive: true });
  const finish = async (execution: { exitCode: number | null; childSignal: NodeJS.Signals | null }): Promise<CommandDiagnostic> => {
    const finishedAt = new Date().toISOString(); stdout = redact(stdout); stderr = redact(stderr);
    const outcomePlan = capabilityUnsupported ? { ...plan, supported: false, disposition: "capability_unsupported" as const, reason: stderr || "Git evidence safety binding is unavailable." } : plan;
    const outcome = classifyValidationExecution({ plan: outcomePlan, exitCode: execution.exitCode, signal: execution.childSignal, timedOut, cancelled, spawnError: setupFailure, stdout, stderr });
    const stdoutTruncated = Buffer.byteLength(stdout) > 1_000_000, stderrTruncated = Buffer.byteLength(stderr) > 1_000_000;
    const diagnosticGap = outcome.outcome !== "passed" && !stdout.trim() && !stderr.trim() && plan.disposition === "execute";
    const classification = outcome.outcome === "product_failed" ? "product" : outcome.outcome === "setup_failed" ? "setup" : ["runtime_failed", "timed_out", "cancelled"].includes(outcome.outcome) ? "runtime" : null;
    const diagnostic: CommandDiagnostic = {
      command: plan.command, cwd: plan.cwd, executor: plan.lane === "git-evidence" ? "safe-git-evidence" : plan.lane === "docker-validation" ? "docker-shell" : "local-shell", runtime: plan.runtime, lane: plan.lane, argv: plan.argv ?? null,
      startedAt, finishedAt, durationMs: Date.now() - started, exitCode: execution.exitCode, signal: execution.childSignal,
      stdout: stdout.slice(0, 1_000_000), stderr: stderr.slice(0, 1_000_000), stdoutTruncated, stderrTruncated,
      truncation: { stdout: stdoutTruncated, stderr: stderrTruncated, limitBytes: 1_000_000 }, artifactPaths: [artifactPath], timedOut, setupFailure,
      failureReason: outcome.reason, classification, diagnosticGap, infrastructureDefect: diagnosticGap ? "non-zero exit produced empty stdout and stderr" : null, artifactPath,
      outcome: outcome.outcome, acceptance: plan.acceptance, evidenceRole: plan.evidenceRole, requiredCapabilities: plan.requiredCapabilities,
      availableCapabilities: plan.availableCapabilities, missingCapabilities: plan.missingCapabilities, repositoryIdentity: plan.repositoryIdentity ?? null, boundSha: plan.boundSha ?? null, safetyAssertions: plan.safetyAssertions ?? [],
    };
    await writeFile(join(root, artifactPath), JSON.stringify(diagnostic, null, 2) + "\n"); return diagnostic;
  };
  if (plan.disposition !== "execute") return finish({ exitCode: null, childSignal: null });
  if (plan.lane === "git-evidence") {
    if (!gitBinding || plan.cwd !== gitBinding.cwd || plan.repositoryIdentity !== gitBinding.repositoryIdentity || plan.boundSha !== gitBinding.boundSha) {
      capabilityUnsupported = true; stderr = "Git evidence binding is unavailable or does not match the preflight lane.";
      return finish({ exitCode: null, childSignal: null });
    }
    try { const result = await executeGitEvidence({ binding: gitBinding, command: plan.command, timeoutMs, ...(signal ? { signal } : {}) }); stdout = result.stdout; stderr = result.stderr; return finish({ exitCode: result.exitCode, childSignal: null }); }
    catch (error) {
      capabilityUnsupported = error instanceof GitEvidenceCapabilityUnsupportedError;
      setupFailure = !capabilityUnsupported;
      stderr = error instanceof Error ? error.message : String(error);
      return finish({ exitCode: null, childSignal: null });
    }
  }
  if (executeProduct) {
    try {
      const result = await executeProduct(plan, dirname(join(root, artifactPath)));
      stdout = result.stdout; stderr = result.stderr; timedOut = result.timedOut;
      return finish({ exitCode: result.exitCode, childSignal: result.signal as NodeJS.Signals | null });
    } catch (error) {
      setupFailure = true; stderr = error instanceof Error ? error.message : String(error);
      return finish({ exitCode: null, childSignal: null });
    }
  }
  return new Promise((resolveRun) => {
    const child = spawn(plan.command, { cwd: plan.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: safeRuntimeEnv() });
    const stop = () => { cancelled = true; child.kill("SIGTERM"); }; signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { setupFailure = true; stderr += error.message; });
    child.on("close", (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); void finish({ exitCode, childSignal }).then(resolveRun); });
  });
}
function safeRuntimeEnv(): NodeJS.ProcessEnv { const allowed = ["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]; return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
function redact(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
