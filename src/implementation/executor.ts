import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadAdminConfig } from "../admin/config.js";
import { scanSecrets } from "../security/secret-scan.js";
import type { TaskSpecV2, TaskExecutionMode } from "../product/task-spec-v2.js";
import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor } from "../product/task-spec-contract.js";
import { executionPhaseOwner } from "../product/execution-agreement.js";

const execFileAsync = promisify(execFile);
const credentialCache = new Map<string, { at: number; ready: boolean }>();
export type ExecutorStatus = "ready" | "degraded" | "unavailable";
export type ImplementationExecutorCapability = {
  id: string; status: ExecutorStatus; supports: TaskExecutionMode[]; providerCalls: boolean;
  runtime: string[]; providerRequirements: string[]; networkRequirements: string[];
  maxLimits: { timeoutMs: number; repairIterations: number; changedFiles: number; patchBytes: number; providerTokens: number };
  limitations: string[]; command: string | null; model: string | null;
};
export type CommandDiagnostic = {
  command: string; cwd: string; startedAt: string; finishedAt: string; durationMs: number;
  executor: string; runtime: string;
  exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; setupFailure: boolean;
  truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; artifactPaths: string[];
  failureReason: string | null; classification: "product" | "setup" | "runtime" | "provider" | "infrastructure" | null;
  diagnosticGap: boolean; infrastructureDefect: string | null; artifactPath: string;
};
export type ImplementationExecutorRequest = {
  spec: TaskSpecV2; targetRepository: string; workingDirectory: string; projectProfile: Record<string, unknown>;
  acceptanceCriteria: string[]; authorityEnvelope: TaskSpecV2["authority"]; forbiddenZones: string[];
  runtimePolicy: TaskSpecV2["runtime"]; validationProfile: TaskSpecV2["validation"]; artifactRoot: string;
  attempt: number; generation: string; signal?: AbortSignal; onProgress?: (phase: string, detail: string) => void | Promise<void>;
};
export type ImplementationExecutorResult = {
  plan: string[]; changedFiles: string[]; patch: string; validationResults: CommandDiagnostic[];
  unresolvedFindings: string[]; status: "implemented_and_validated" | "no_change_required" | "blocked_with_owner_gate" | "failed_with_diagnostics";
  ownerGate: { required: boolean; reason: string | null }; safetyAssertions: Record<string, boolean>;
  diagnostics: Record<string, unknown>; localBranch: string | null; localCommit: string | null; patchPackage: string | null;
  providerCalls: Array<Record<string, unknown>>; selectedExecutor: { id: string; model: string | null };
};

export async function discoverImplementationExecutors(): Promise<ImplementationExecutorCapability[]> {
  const configured = await configuredCommand();
  if (!configured) return [capability(null, "unavailable", ["No coding-agent CLI was found. Install/configure codex-cli or set RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND."])];
  const argv = splitCommand(configured.command);
  if (!argv.length || !(await executableAvailable(argv[0]!))) return [capability(configured.command, "unavailable", [`Executor command is unavailable: ${argv[0] ?? "empty"}.`], configured.model)];
  if (/(?:^|\/)codex$/.test(argv[0]!) && !(await codexCredentialReady(argv))) return [capability(configured.command, "unavailable", ["Codex CLI credential status is unavailable; authenticate through the existing local credential mechanism."], configured.model)];
  return [capability(configured.command, "ready", [], configured.model)];
}

export async function selectImplementationExecutor(spec: TaskSpecV2): Promise<{ selected: ImplementationExecutorCapability | null; reason: string; rejected: Array<{ id: string; reason: string }> }> {
  const executors = await discoverImplementationExecutors();
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const executor of executors) {
    const reasons: string[] = [];
    if (executor.status !== "ready") reasons.push(...executor.limitations);
    if (!executor.supports.includes(spec.execution.mode)) reasons.push(`mode ${spec.execution.mode} is unsupported`);
    if (!runtimeCompatibleWithImplementationExecutor(spec.runtime.preference)) reasons.push(`runtime ${spec.runtime.preference} is unsupported; ${executor.id} accepts: ${executor.runtime.join(", ")}`);
    if (spec.execution.maxProviderTokens > executor.maxLimits.providerTokens) reasons.push(`provider token budget exceeds executor limit ${executor.maxLimits.providerTokens}`);
    if (executor.providerCalls && !spec.authority.allowProviderCalls) reasons.push("provider calls denied by TaskSpec authority");
    if (executor.providerCalls && (!spec.authority.allowNetwork || spec.runtime.externalNetwork !== "allowed")) reasons.push("provider network denied by TaskSpec authority/runtime policy");
    if (reasons.length) { rejected.push({ id: executor.id, reason: reasons.join("; ") }); continue; }
    return { selected: executor, reason: `Deterministic policy selected the first ready executor supporting ${spec.execution.mode}, local disposable runtime, provider and network authority, and requested limits.`, rejected };
  }
  return { selected: null, reason: "No compatible ready implementation executor.", rejected };
}

export async function runImplementationExecutor(request: ImplementationExecutorRequest): Promise<ImplementationExecutorResult> {
  const selection = await selectImplementationExecutor(request.spec);
  if (!selection.selected?.command) throw new Error(`executor_unavailable: ${selection.reason} ${selection.rejected.map((item) => `${item.id}: ${item.reason}`).join("; ")}`);
  const executor = selection.selected;
  const executorCommand = executor.command!;
  const sourceBefore = await git(request.targetRepository, ["rev-parse", "HEAD"]);
  if (sourceBefore.trim() !== request.spec.target.expectedSha) throw new Error(`target_sha_mismatch: expected ${request.spec.target.expectedSha}, current ${sourceBefore.trim()}`);
  const sourceStatusBefore = await git(request.targetRepository, ["status", "--porcelain=v1"]);
  if (sourceStatusBefore.trim()) throw new Error("active_human_work_conflict: implementation requires a clean known source worktree; existing changes were preserved.");
  const workspace = join(dirname(request.artifactRoot), "workspace");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(dirname(workspace), { recursive: true });
  await progress(request, "understand_task", "Task, acceptance criteria, authority and forbidden zones normalized.");
  const branchOwnedByRunForge = executionPhaseOwner(
    request.spec.executionAgreement.profile,
    "localBranch",
    request.spec.executionAgreement.phaseOwnership,
  ) === "runforge";
  const commitOwnedByRunForge = executionPhaseOwner(
    request.spec.executionAgreement.profile,
    "localCommit",
    request.spec.executionAgreement.phaseOwnership,
  ) === "runforge";
  const localBranch = branchOwnedByRunForge ? localBranchName(request.spec.taskId) : null;
  if (localBranch && await localRefExists(request.targetRepository, localBranch)) {
    throw new Error(`local_branch_collision: refusing to overwrite refs/heads/${localBranch}`);
  }
  await git(request.targetRepository, localBranch
    ? ["worktree", "add", "-b", localBranch, workspace, request.spec.target.expectedSha]
    : ["worktree", "add", "--detach", workspace, request.spec.target.expectedSha]);
  const executionRoot = resolve(workspace, request.workingDirectory);
  if (!isInside(workspace, executionRoot)) throw new Error("working_directory_escape");
  const plan = ["Inspect the target and acceptance criteria", "Implement only bounded changes in the disposable worktree", "Run declared validation", "Repair in-scope failures within the iteration budget", "Finalize patch/commit evidence without publication"];
  await mkdir(request.artifactRoot, { recursive: true });
  await writeFile(join(request.artifactRoot, "implementation-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  const providerCalls: Array<Record<string, unknown>> = [];
  const validations: CommandDiagnostic[] = [];
  let agentSummary = "";
  let status: ImplementationExecutorResult["status"] = "failed_with_diagnostics";
  let unresolved: string[] = [];
  let patch = "";
  let changedFiles: string[] = [];
  let localCommit: string | null = null;
  try {
    for (let iteration = 0; iteration <= request.spec.execution.maxRepairIterations; iteration += 1) {
      const phase = iteration === 0 ? "implement" : "repair";
      await progress(request, phase, iteration === 0 ? "Coding executor is implementing the bounded task." : `Repair iteration ${iteration} is addressing validation failures.`);
      const prompt = buildPrompt(request, iteration, validations);
      const call = await runAgent(executorCommand, executor.model, executionRoot, prompt, request.spec.execution.timeoutMs, request.signal, request.artifactRoot, iteration);
      providerCalls.push({ command: "local-coding-agent", cwd: executionRoot, executor: executor.id, runtime: "local-disposable", executorId: executor.id, model: executor.model, providerCalls: true, networkAuthorized: true, iteration, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, exitCode: call.exitCode, signal: call.signal, timedOut: call.timedOut, stdout: call.stdout, stderr: call.stderr, truncation: call.truncation, artifactPaths: [call.stdoutArtifact, call.stderrArtifact], failureReason: call.failureReason, classification: call.exitCode === 0 ? null : "provider", diagnosticGap: call.exitCode !== 0 && !call.stdout.trim() && !call.stderr.trim(), tokenUsage: call.tokenUsage, tokenBudget: request.spec.execution.maxProviderTokens, stdoutArtifact: call.stdoutArtifact, stderrArtifact: call.stderrArtifact });
      agentSummary = call.summary;
      if (call.cancelled) throw new Error("cancelled");
      if (call.exitCode !== 0) { unresolved = [`Coding agent failed with exit ${call.exitCode ?? "signal"}.`]; break; }
      if (call.tokenUsage !== null && call.tokenUsage > request.spec.execution.maxProviderTokens) { unresolved = [`Provider token budget exceeded: ${call.tokenUsage} > ${request.spec.execution.maxProviderTokens}.`]; status = "blocked_with_owner_gate"; break; }
      await git(workspace, ["add", "-N", "."]);
      patch = await git(workspace, ["diff", "--binary", "--no-ext-diff", request.spec.target.expectedSha]);
      changedFiles = lines(await git(workspace, ["diff", "--name-only", request.spec.target.expectedSha]));
      if (!changedFiles.length) {
        const ambiguous = /ambiguous|clarif|product decision|cannot determine/i.test(agentSummary);
        status = ambiguous ? "blocked_with_owner_gate" : /no change|required|already (?:correct|fixed)|false positive/i.test(agentSummary) ? "no_change_required" : "failed_with_diagnostics";
        unresolved = ambiguous ? ["New product semantics or clarification is required."] : status === "no_change_required" ? [] : ["Implementation executor produced no change and did not establish no_change_required."];
        break;
      }
      const safetyErrors = validateChangedPaths(changedFiles, request.forbiddenZones, request.spec.execution.maxChangedFiles);
      if (Buffer.byteLength(patch) > request.spec.execution.maxPatchBytes) safetyErrors.push(`Patch exceeds ${request.spec.execution.maxPatchBytes} bytes.`);
      const secretScan = scanSecrets(addedPatchLines(patch));
      if (secretScan.status === "failed") safetyErrors.push("Secret scan rejected the patch.");
      if (safetyErrors.length) { unresolved = safetyErrors; status = "blocked_with_owner_gate"; break; }
      await progress(request, "validate", `Running ${request.validationProfile.commands.length} validation command(s).`);
      validations.splice(0, validations.length);
      for (let index = 0; index < request.validationProfile.commands.length; index += 1) validations.push(await runValidation(request.validationProfile.commands[index]!, executionRoot, request.artifactRoot, iteration, index, request.spec.execution.timeoutMs, request.signal));
      if (validations.every((item) => item.exitCode === 0)) { status = "implemented_and_validated"; break; }
      unresolved = validations.filter((item) => item.exitCode !== 0).map((item) => `${item.command}: exit ${item.exitCode}${item.infrastructureDefect ? ` (${item.infrastructureDefect})` : ""}`);
    }
    if (status === "implemented_and_validated" || status === "no_change_required") {
      if (commitOwnedByRunForge) {
        await progress(request, "finalize", "Creating the RunForge-owned local commit and patch package; publication remains on hold.");
        await git(workspace, ["add", "-A"]);
        await git(workspace, ["-c", "user.name=RunForge Executor", "-c", "user.email=runforge@localhost", "commit", ...(status === "no_change_required" ? ["--allow-empty"] : []), "-m", `RunForge ${request.spec.taskId}`]);
        localCommit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
        patch = await git(workspace, ["format-patch", "-1", "--stdout", localCommit]);
        changedFiles = lines(await git(workspace, ["diff-tree", "--no-commit-id", "--name-only", "-r", localCommit]));
      } else {
        await progress(request, "finalize", "Preserving the validated binary diff without creating an externally owned commit.");
      }
    }
    const patchPackage = patch ? join(request.artifactRoot, "implementation.patch") : null;
    if (patchPackage) await writeFile(patchPackage, patch, "utf8");
    const sourceAfter = (await git(request.targetRepository, ["rev-parse", "HEAD"])).trim();
    const sourceStatusAfter = await git(request.targetRepository, ["status", "--porcelain=v1"]);
    return {
      plan, changedFiles, patch, validationResults: validations, unresolvedFindings: unresolved, status,
      ownerGate: { required: status === "blocked_with_owner_gate", reason: status === "blocked_with_owner_gate" ? unresolved.join(" ") : null },
      safetyAssertions: { sourceShaUnchanged: sourceAfter === sourceBefore.trim(), sourceWorktreeStateUnchanged: sourceStatusAfter === sourceStatusBefore, targetMainMutation: false, targetMainPush: false, merge: false, deploy: false, publicationPerformed: false, forbiddenZonesRespected: !unresolved.some((item) => item.includes("forbidden")), secretScanPassed: !unresolved.includes("Secret scan rejected the patch.") },
      diagnostics: { agentSummary, sourceBefore: sourceBefore.trim(), sourceAfter, sourceWorktreeStatusBefore: sourceStatusBefore, sourceWorktreeStatusAfter: sourceStatusAfter, selectionReason: selection.reason, rejectedAlternatives: selection.rejected, workspace: relative(request.targetRepository, workspace) },
      localBranch, localCommit, patchPackage, providerCalls, selectedExecutor: { id: executor.id, model: executor.model }
    };
  } finally {
    await git(request.targetRepository, ["worktree", "remove", "--force", workspace]).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

function capability(command: string | null, status: ExecutorStatus, limitations: string[], model: string | null = process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null): ImplementationExecutorCapability { const result = { id: implementationExecutorContract.id, status, supports: [...implementationExecutorContract.modes], providerCalls: true, runtime: [...implementationExecutorContract.runtimes], providerRequirements: ["existing local coding-agent credential mechanism"], networkRequirements: ["provider transport; denied unless separately authorized"], maxLimits: implementationExecutorContract.maxLimits, limitations, model } as ImplementationExecutorCapability; Object.defineProperty(result, "command", { value: command, enumerable: false }); return result; }
async function configuredCommand(): Promise<{ command: string; model: string | null } | null> { const env = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND?.trim(); if (env) return { command: env, model: process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null }; const config = await loadAdminConfig(); const provider = config.config.providers.find((item) => item.id === "codex-cli" && item.type === "cli" && item.enabled && item.command); if (provider?.command) return { command: provider.command, model: provider.defaultModel ?? null }; return executableAvailable("codex").then((ready) => ready ? { command: "codex", model: process.env.RUNFORGE_IMPLEMENTATION_MODEL ?? null } : null); }
async function executableAvailable(command: string): Promise<boolean> { if (command.includes("/")) return access(command).then(() => true, () => false); return execFileAsync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]).then(() => true, () => false); }
async function codexCredentialReady(argv: string[]): Promise<boolean> { const key = argv.join("\0"), cached = credentialCache.get(key); if (cached && Date.now() - cached.at < 30_000) return cached.ready; const ready = await execFileAsync(argv[0]!, [...argv.slice(1), "login", "status"], { env: safeRuntimeEnv(), timeout: 10_000 }).then(() => true, () => false); credentialCache.set(key, { at: Date.now(), ready }); return ready; }
function splitCommand(value: string): string[] { return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")) ?? []; }
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout; }
async function localRefExists(repository: string, branch: string): Promise<boolean> {
  return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository })
    .then(() => true, (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
      throw error;
    });
}
function localBranchName(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `runforge/${slug}`;
}
function addedPatchLines(patch: string): string {
  const added: string[] = [];
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) { inHunk = false; continue; }
    if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}
function lines(text: string): string[] { return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function isInside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")); }
async function progress(request: ImplementationExecutorRequest, phase: string, detail: string): Promise<void> { await request.onProgress?.(phase, detail); }
function validateChangedPaths(files: string[], zones: string[], max: number): string[] { const errors: string[] = []; if (files.length > max) errors.push(`Changed files exceed limit ${max}.`); const pathZones = zones.filter((zone) => !/\s/.test(zone)).map((zone) => zone.replace(/^\.\//, "").replace(/\*\*|\*/g, "").replace(/\/$/, "")); for (const file of files) { if (file.startsWith("../") || file.startsWith("/")) errors.push(`Path escapes workspace: ${file}.`); const zone = pathZones.find((item) => item && (file === item || file.startsWith(`${item}/`))); if (zone) errors.push(`Changed path is forbidden: ${file} (${zone}).`); } return errors; }
function buildPrompt(request: ImplementationExecutorRequest, iteration: number, validations: CommandDiagnostic[]): string { return [`You are the RunForge bounded implementation executor. Work only in the current disposable Git worktree.`, `Task: ${request.spec.task.text}`, `Goal: ${request.spec.task.goal}`, `Acceptance criteria:\n${request.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, `Forbidden zones:\n${request.forbiddenZones.map((item) => `- ${item}`).join("\n")}`, `Validation commands:\n${request.validationProfile.commands.map((item) => `- ${item}`).join("\n")}`, `Provider token budget: at most ${request.spec.execution.maxProviderTokens} total tokens for this call.`, `Iteration: ${iteration}. ${iteration ? `Repair these failures:\n${validations.filter((item) => item.exitCode !== 0).map((item) => `${item.command}\nstdout: ${item.stdout}\nstderr: ${item.stderr}`).join("\n")}` : "Inspect, plan, implement, and add/update tests as required."}`, `Do not create a Git commit; leave changes uncommitted so RunForge can validate and create the final local commit.`, `Do not push, open a PR, merge, deploy, access secrets/DB/production, or modify forbidden paths. Do not merely propose a patch: edit files and validate. If no change is required, say exactly 'no change required' with evidence. If semantics are ambiguous, stop and say 'ambiguous product decision'.`].join("\n\n"); }

async function runAgent(commandText: string, model: string | null, cwd: string, prompt: string, timeoutMs: number, signal: AbortSignal | undefined, root: string, iteration: number): Promise<{ startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null; summary: string; cancelled: boolean; timedOut: boolean; stdout: string; stderr: string; truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; failureReason: string | null; tokenUsage: number | null; stdoutArtifact: string; stderrArtifact: string }> {
  const argv = splitCommand(commandText); const command = argv.shift()!; const isCodex = /(?:^|\/)codex$/.test(command);
  const args = isCodex ? [...argv, "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", cwd, ...(model ? ["--model", model] : []), prompt] : argv;
  const started = Date.now(), startedAt = new Date(started).toISOString(); let stdout = "", stderr = "", timedOut = false, cancelled = false;
  const stdoutArtifact = `provider/iteration-${iteration}.stdout.log`, stderrArtifact = `provider/iteration-${iteration}.stderr.log`;
  await mkdir(join(root, "provider"), { recursive: true });
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: [isCodex ? "ignore" : "pipe", "pipe", "pipe"], env: { ...safeRuntimeEnv(), RUNFORGE_IMPLEMENTATION_REQUEST: join(root, "task-spec.normalized.json"), RUNFORGE_IMPLEMENTATION_PROMPT: prompt, RUNFORGE_NETWORK_POLICY: "provider-only" } });
    if (!isCodex) { child.stdin?.end(prompt); }
    const stop = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { if (Buffer.byteLength(stdout) < 2_000_000) stdout += chunk; }); child.stderr?.on("data", (chunk) => { if (Buffer.byteLength(stderr) < 2_000_000) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); const finishedAt = new Date().toISOString(); const safeStdout = redactProviderOutput(stdout), safeStderr = redactProviderOutput(stderr); const normalizedExit = timedOut ? null : exitCode; const failureReason = normalizedExit === 0 ? null : timedOut ? `Implementation provider timed out after ${timeoutMs}ms.` : cancelled ? "Implementation provider was cancelled." : safeStdout.trim() || safeStderr.trim() ? `Implementation provider exited with code ${normalizedExit ?? "signal"}.` : "Implementation provider exited non-zero without stdout or stderr."; void Promise.all([writeFile(join(root, stdoutArtifact), safeStdout), writeFile(join(root, stderrArtifact), safeStderr)]).then(() => resolveRun({ startedAt, finishedAt, durationMs: Date.now() - started, exitCode: normalizedExit, signal: childSignal, summary: extractSummary(safeStdout, safeStderr), cancelled, timedOut, stdout: safeStdout, stderr: safeStderr, truncation: { stdout: Buffer.byteLength(stdout) >= 2_000_000, stderr: Buffer.byteLength(stderr) >= 2_000_000, limitBytes: 2_000_000 }, failureReason, tokenUsage: extractTokenUsage(safeStdout), stdoutArtifact, stderrArtifact }), reject); });
  });
}
function extractSummary(stdout: string, stderr: string): string { const finals = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const text = item.msg?.message ?? item.message ?? item.text ?? item.item?.text; return typeof text === "string" ? [text] : []; } catch { return []; } }); return (finals.at(-1) ?? stdout ?? stderr).slice(-20_000); }
export function extractTokenUsage(stdout: string): number | null { const values = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const usage = item.usage ?? item.token_usage ?? item.item?.usage; const input = usage?.input_tokens ?? usage?.inputTokens, cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0, output = usage?.output_tokens ?? usage?.outputTokens; if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached)) return [Math.max(0, Number(input) - Number(cached)) + Number(output)]; const explicit = usage?.total_tokens ?? usage?.totalTokens ?? item.total_tokens; return Number.isFinite(explicit) ? [Number(explicit)] : []; } catch { return []; } }); return values.length ? Math.max(...values) : null; }
async function runValidation(command: string, cwd: string, root: string, iteration: number, index: number, timeoutMs: number, signal?: AbortSignal): Promise<CommandDiagnostic> { const started = Date.now(), startedAt = new Date(started).toISOString(); let stdout = "", stderr = "", timedOut = false, setupFailure = false; const artifactPath = `validation/iteration-${iteration}/command-${index}.json`; await mkdir(dirname(join(root, artifactPath)), { recursive: true }); return new Promise((resolveRun) => { const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: safeRuntimeEnv() }); const stop = () => child.kill("SIGTERM"); signal?.addEventListener("abort", stop, { once: true }); const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs); child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; }); child.on("error", (error) => { setupFailure = true; stderr += error.message; }); child.on("close", (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); const finishedAt = new Date().toISOString(); stdout = redactProviderOutput(stdout); stderr = redactProviderOutput(stderr); const stdoutTruncated = Buffer.byteLength(stdout) > 1_000_000, stderrTruncated = Buffer.byteLength(stderr) > 1_000_000; const diagnosticGap = exitCode !== 0 && !stdout.trim() && !stderr.trim(); const failureReason = exitCode === 0 ? null : timedOut ? `Validation timed out after ${timeoutMs}ms.` : setupFailure ? "Validation command could not be started." : diagnosticGap ? "Validation exited non-zero without stdout or stderr." : `Validation command exited with code ${exitCode ?? "signal"}.`; const classification = exitCode === 0 ? null : setupFailure ? "setup" as const : timedOut || childSignal ? "runtime" as const : diagnosticGap ? "infrastructure" as const : "product" as const; const diagnostic: CommandDiagnostic = { command, cwd, executor: "local-coding-agent", runtime: "local-disposable", startedAt, finishedAt, durationMs: Date.now() - started, exitCode, signal: childSignal, stdout: stdout.slice(0, 1_000_000), stderr: stderr.slice(0, 1_000_000), stdoutTruncated, stderrTruncated, truncation: { stdout: stdoutTruncated, stderr: stderrTruncated, limitBytes: 1_000_000 }, artifactPaths: [artifactPath], timedOut, setupFailure, failureReason, classification, diagnosticGap, infrastructureDefect: diagnosticGap ? "non-zero exit produced empty stdout and stderr" : null, artifactPath }; void writeFile(join(root, artifactPath), JSON.stringify(diagnostic, null, 2) + "\n").then(() => resolveRun(diagnostic)); }); }); }
function safeRuntimeEnv(): NodeJS.ProcessEnv { const allowed = ["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]; return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
function redactProviderOutput(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
