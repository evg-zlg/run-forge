import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadAdminConfig } from "../admin/config.js";
import { scanSecrets } from "../security/secret-scan.js";
import type { TaskSpecV2, TaskExecutionMode } from "../product/task-spec-v2.js";
import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor } from "../product/task-spec-contract.js";
import { persistDurableCheckpoint } from "./durable-checkpoint.js";
import { executionPhaseOwner } from "../product/execution-agreement.js";

const execFileAsync = promisify(execFile);
const credentialCache = new Map<string, { at: number; ready: boolean }>();
const RUNFORGE_DEPENDENCY_PATHS = [
  ":(exclude).pnpm-store",
  ":(exclude).pnpm-store/**",
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
] as const;
export type ExecutorStatus = "ready" | "degraded" | "unavailable";
export type ImplementationExecutorCapability = {
  id: string; status: ExecutorStatus; supports: TaskExecutionMode[]; providerCalls: boolean;
  runtime: string[]; providerRequirements: string[]; networkRequirements: string[];
  maxLimits: Readonly<Record<keyof typeof implementationExecutorContract.maxLimits, number>>;
  limitations: string[]; command: string | null; model: string | null;
};
type ProviderCapabilities = {
  maxInputContextTokens: number;
  maxOutputTokens: number;
  maxReasoningTokens: number;
  maxWallClockMs: number;
  maxCallsPerPhase: number;
  maxCostUsd: number | null;
  guarantees: { inputTokens: boolean; outputTokens: boolean; reasoningTokens: boolean; wallClock: boolean; calls: boolean; cost: boolean };
};
type ExecutionEnvelope = {
  profile: string; model: string | null; taskId: string; phase: "implementation" | "repair"; call: number;
  limits: { maxInputContextTokens: number; maxOutputTokens: number; maxReasoningTokens: number; maxWallClockMs: number; maxCallsPerPhase: number; maxPhaseTokens: number; maxTaskTokens: number; maxCostUsd: number | null };
  remaining: { phaseTokens: number; taskTokens: number; taskTimeMs: number; costUsd: number | null };
};
type ProgressSignals = { filesInspected: string[]; exactDiagnosis: string | null; redTest: string | null; candidateDiff: string | null; partialPatch: string | null; tests: string[]; lastMeaningfulOutput: string | null; usage: { tokens: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; costUsd: number | null } };
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
  checkpoints: Array<{ id: string; path: string; patchPath: string; iteration: number; validationPassed: boolean }>;
  budget: { exceeded: boolean; overrunPhase: "implementation" | "repair" | null; requestedTokens: number; actualTokens: number; accounting: "provider" | "synthetic"; costUsd: number | null };
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
  const providerCapability = configuredProviderCapabilities(executor);
  assertMandatoryProviderCaps(providerCapability, request);
  const sourceBefore = await git(request.targetRepository, ["rev-parse", "HEAD"]);
  if (sourceBefore.trim() !== request.spec.target.expectedSha) throw new Error(`target_sha_mismatch: expected ${request.spec.target.expectedSha}, current ${sourceBefore.trim()}`);
  const sourceStatusBefore = await git(request.targetRepository, ["status", "--porcelain=v1"]);
  const dirtyPolicy = request.spec.target.dirtyPolicy ?? "use_disposable_from_base_sha";
  if (sourceStatusBefore.trim() && (dirtyPolicy === "require_clean" || dirtyPolicy === "allow_known_generated" && unsafeDirtyLines(sourceStatusBefore).length)) throw new Error(`active_human_work_conflict: dirtyPolicy=${dirtyPolicy} preserved existing changes.`);
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
  const localBranch = branchOwnedByRunForge ? localBranchName(request.spec.taskId, request.generation, request.attempt) : null;
  if (localBranch && await localRefExists(request.targetRepository, localBranch)) {
    throw new Error(`local_branch_collision: refusing to overwrite refs/heads/${localBranch}`);
  }
  await git(request.targetRepository, localBranch
    ? ["worktree", "add", "-b", localBranch, workspace, request.spec.target.expectedSha]
    : ["worktree", "add", "--detach", workspace, request.spec.target.expectedSha]);
  const executionRoot = resolve(workspace, request.workingDirectory);
  if (!isInside(workspace, executionRoot)) throw new Error("working_directory_escape");
  const plan = ["Inspect the target and acceptance criteria", "Implement only bounded changes in the disposable worktree", "Run declared validation", "Repair in-scope failures within the iteration budget", "Finalize patch/commit evidence without publication"];
  const contextPlan = await buildContextPlan(request, executionRoot);
  await mkdir(request.artifactRoot, { recursive: true });
  await writeFile(join(request.artifactRoot, "implementation-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  await writeFile(join(request.artifactRoot, "context-plan.json"), JSON.stringify(contextPlan, null, 2) + "\n");
  const providerCalls: Array<Record<string, unknown>> = [];
  const checkpoints: ImplementationExecutorResult["checkpoints"] = [];
  const validations: CommandDiagnostic[] = [];
  let agentSummary = "";
  let status: ImplementationExecutorResult["status"] = "failed_with_diagnostics";
  let unresolved: string[] = [];
  let patch = "";
  let changedFiles: string[] = [];
  let localCommit: string | null = null;
  let budgetExceeded = false;
  let overrunPhase: ImplementationExecutorResult["budget"]["overrunPhase"] = null;
  let overrunActual = 0, overrunLimit = request.spec.execution.maxProviderTokens;
  let actualCostUsd = 0;
  const taskStarted = Date.now();
  const phaseCalls = { implementation: 0, repair: 0 };
  let checkpointSequence = 0;
  let noProgress = false;
  const persistWorkspaceCheckpoint = async (iteration: number, reason: string, signals: ProgressSignals, validationPassed = false): Promise<void> => {
    await stageWorkspaceChanges(workspace, true);
    const currentPatch = await filteredWorkspaceDiff(workspace, request.spec.target.expectedSha, ["--binary", "--no-ext-diff"]);
    const currentFiles = lines(await filteredWorkspaceDiff(workspace, request.spec.target.expectedSha, ["--name-only"]));
    if (!currentPatch || !currentFiles.length) return;
    const checkpointSafetyErrors = validateChangedPaths(currentFiles, request.forbiddenZones, request.spec.execution.maxChangedFiles);
    if (Buffer.byteLength(currentPatch) > request.spec.execution.maxPatchBytes) checkpointSafetyErrors.push(`Patch exceeds ${request.spec.execution.maxPatchBytes} bytes.`);
    if (scanSecrets(addedPatchLines(currentPatch)).status === "failed") checkpointSafetyErrors.push("Secret scan rejected the patch.");
    if (checkpointSafetyErrors.length) return;
    patch = currentPatch; changedFiles = currentFiles;
    const phase = iteration === 0 ? "implementation" : "repair";
    const checkpoint = await persistDurableCheckpoint(request.artifactRoot, {
      checkpointId: `${phase}-${iteration}-${reason}-${checkpointSequence++}`,
      iteration, kind: phase, baseSha: request.spec.target.expectedSha, workspaceSha: null, workspaceState: "dirty",
      patch, changedFiles, validation: validations,
      usage: { accounting: process.env.RUNFORGE_USAGE_ACCOUNTING === "synthetic" ? "synthetic" : "provider", phase, providerCalls: providerCalls.length, totalTokens: totalProviderTokens(providerCalls), costUsd: actualCostUsd, progressSignals: signals, reason },
      executor: { id: executor.id, model: executor.model, runtime: "local-disposable", attempt: request.attempt, generation: request.generation },
      safetyAssertions: { targetMainMutation: false, targetMainPush: false, forbiddenZonesRespected: true, secretScanPassed: true }, unresolvedFindings: unresolved,
    });
    checkpoints.push({ id: checkpoint.id, path: relative(request.artifactRoot, checkpoint.path), patchPath: relative(request.artifactRoot, checkpoint.patchPath), iteration, validationPassed });
  };
  try {
    for (let iteration = 0; iteration <= request.spec.execution.maxRepairIterations; iteration += 1) {
      const phaseName = iteration === 0 ? "implementation" : "repair";
      const phase = iteration === 0 ? "implement" : "repair";
      const actualTokensBefore = totalProviderTokens(providerCalls);
      const phaseTokensBefore = providerCalls.filter((item) => item.phase === phaseName).reduce((sum, item) => sum + numeric(item.tokenUsage), 0);
      const phaseLimit = request.spec.execution.phaseBudgets[phaseName];
      const maxCostUsd = optionalPositive((request.spec.execution as unknown as Record<string, unknown>).maxCostUsd);
      const requestedCalls = optionalPositive((request.spec.execution as unknown as Record<string, unknown>).maxCallsPerPhase) ?? 1;
      const taskTimeRemaining = request.spec.execution.timeoutMs - (Date.now() - taskStarted);
      const remainingPhase = phaseLimit - phaseTokensBefore, remainingTask = request.spec.execution.maxProviderTokens - actualTokensBefore;
      if (phaseCalls[phaseName] >= Math.min(requestedCalls, providerCapability.maxCallsPerPhase) || remainingPhase <= 0 || remainingTask <= 0 || taskTimeRemaining <= 0 || (maxCostUsd !== null && actualCostUsd >= maxCostUsd)) {
        budgetExceeded = true; overrunPhase = phaseName; unresolved = [`pre_call_budget_stop: no bounded ${phaseName} provider call remains.`]; status = "blocked_with_owner_gate"; break;
      }
      const envelope = deriveExecutionEnvelope(request, executor, providerCapability, phaseName, phaseCalls[phaseName] + 1, remainingPhase, remainingTask, taskTimeRemaining, maxCostUsd === null ? null : maxCostUsd - actualCostUsd);
      phaseCalls[phaseName] += 1;
      await progress(request, phase, iteration === 0 ? "Coding executor is implementing the bounded task." : `Repair iteration ${iteration} is addressing validation failures.`);
      const prompt = truncatePrompt(buildPrompt(request, iteration, validations), envelope.limits.maxInputContextTokens);
      const call = await runAgent(executorCommand, executor.model, executionRoot, prompt, envelope, request.signal, request.artifactRoot, iteration, async (signals) => {
        if (signals.candidateDiff || signals.partialPatch) await persistWorkspaceCheckpoint(iteration, "stream", signals);
      });
      providerCalls.push({ command: "local-coding-agent", cwd: executionRoot, executor: executor.id, runtime: "local-disposable", executorId: executor.id, model: executor.model, providerCalls: true, networkAuthorized: true, usageAccounting: process.env.RUNFORGE_USAGE_ACCOUNTING === "synthetic" ? "synthetic" : "provider", phase: phaseName, iteration, executionEnvelope: envelope, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs, exitCode: call.exitCode, signal: call.signal, timedOut: call.timedOut, noProgress: call.noProgress, stdout: call.stdout, stderr: call.stderr, truncation: call.truncation, artifactPaths: [call.stdoutArtifact, call.stderrArtifact], failureReason: call.failureReason, classification: call.exitCode === 0 ? null : "provider", diagnosticGap: call.exitCode !== 0 && !call.stdout.trim() && !call.stderr.trim(), tokenUsage: call.tokenUsage, costUsd: call.costUsd, progressSignals: call.progressSignals, tokenBudget: request.spec.execution.maxProviderTokens, stdoutArtifact: call.stdoutArtifact, stderrArtifact: call.stderrArtifact });
      agentSummary = call.summary;
      actualCostUsd += call.costUsd ?? 0;
      await persistWorkspaceCheckpoint(iteration, "termination", call.progressSignals);
      if (call.cancelled) throw new Error("cancelled");
      if (call.noProgress) { noProgress = true; unresolved = ["no_progress: implementation attempt produced no useful streamed signal before the early deadline."]; status = "failed_with_diagnostics"; break; }
      if (call.exitCode !== 0) {
        const providerFailure = `Coding agent failed with exit ${call.exitCode ?? "signal"}: ${call.failureReason ?? "provider failure"}`;
        const durableCheckpoint = checkpoints.at(-1);
        unresolved = [durableCheckpoint ? `checkpoint_available: durable partial patch/checkpoint is available at ${durableCheckpoint.patchPath}. ${providerFailure}` : providerFailure];
        break;
      }
      await stageWorkspaceChanges(workspace, true);
      patch = await filteredWorkspaceDiff(workspace, request.spec.target.expectedSha, ["--binary", "--no-ext-diff"]);
      changedFiles = lines(await filteredWorkspaceDiff(workspace, request.spec.target.expectedSha, ["--name-only"]));
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
      if (safetyErrors.length) { unresolved = safetyErrors; status = "blocked_with_owner_gate"; }
      await progress(request, "validate", `Running ${request.validationProfile.commands.length} validation command(s).`);
      validations.splice(0, validations.length);
      if (!safetyErrors.length) for (let index = 0; index < request.validationProfile.commands.length; index += 1) validations.push(await runValidation(request.validationProfile.commands[index]!, executionRoot, request.artifactRoot, iteration, index, request.spec.execution.timeoutMs, request.signal));
      const validationPassed = !safetyErrors.length && validations.every((item) => item.exitCode === 0);
      if (!validationPassed && !safetyErrors.length) unresolved = validations.filter((item) => item.exitCode !== 0).map((item) => `${item.command}: exit ${item.exitCode}${item.infrastructureDefect ? ` (${item.infrastructureDefect})` : ""}`);
      const actualTokens = totalProviderTokens(providerCalls);
      const checkpoint = await persistDurableCheckpoint(request.artifactRoot, {
        checkpointId: `${iteration === 0 ? "implementation" : "repair"}-${iteration}`,
        iteration, kind: iteration === 0 ? "implementation" : "repair", baseSha: request.spec.target.expectedSha,
        workspaceSha: null, workspaceState: "dirty", patch, changedFiles, validation: validations,
        usage: { accounting: providerCalls.at(-1)?.usageAccounting ?? "provider", phase, providerCalls: providerCalls.length, totalTokens: actualTokens, costUsd: actualCostUsd || null },
        executor: { id: executor.id, model: executor.model, runtime: "local-disposable", attempt: request.attempt, generation: request.generation },
        safetyAssertions: { targetMainMutation: false, targetMainPush: false, forbiddenZonesRespected: safetyErrors.length === 0, secretScanPassed: !safetyErrors.includes("Secret scan rejected the patch.") },
        unresolvedFindings: unresolved
      });
      checkpoints.push({ id: checkpoint.id, path: relative(request.artifactRoot, checkpoint.path), patchPath: relative(request.artifactRoot, checkpoint.patchPath), iteration, validationPassed });
      const phaseExceeded = phaseTokensBefore + (call.tokenUsage ?? 0) > phaseLimit, totalExceeded = actualTokens > request.spec.execution.maxProviderTokens, costExceeded = maxCostUsd !== null && actualCostUsd > maxCostUsd;
      const responseCapExceeded = numeric(call.progressSignals.usage.outputTokens) > envelope.limits.maxOutputTokens || numeric(call.progressSignals.usage.reasoningTokens) > envelope.limits.maxReasoningTokens || (envelope.limits.maxCostUsd !== null && numeric(call.costUsd) > envelope.limits.maxCostUsd);
      budgetExceeded = totalExceeded || phaseExceeded || costExceeded || responseCapExceeded;
      if (budgetExceeded) { overrunPhase = phase === "implement" ? "implementation" : "repair"; overrunActual = phaseExceeded ? call.tokenUsage ?? 0 : actualTokens; overrunLimit = phaseExceeded ? phaseLimit : request.spec.execution.maxProviderTokens; }
      if (validationPassed) { status = "implemented_and_validated"; break; }
      if (budgetExceeded || safetyErrors.length) { status = "blocked_with_owner_gate"; break; }
    }
    if (status === "implemented_and_validated" || status === "no_change_required") {
      if (commitOwnedByRunForge) {
        await progress(request, "finalize", "Creating the RunForge-owned local commit and patch package; publication remains on hold.");
        await stageWorkspaceChanges(workspace, false);
        await git(workspace, ["-c", "user.name=RunForge Executor", "-c", "user.email=runforge@localhost", "commit", ...(status === "no_change_required" ? ["--allow-empty"] : []), "-m", `RunForge ${request.spec.taskId}`]);
        localCommit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
        patch = await git(workspace, ["format-patch", "-1", "--stdout", localCommit]);
        changedFiles = lines(await git(workspace, ["diff-tree", "--no-commit-id", "--name-only", "-r", localCommit, "--", ".", ...RUNFORGE_DEPENDENCY_PATHS]));
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
      ownerGate: { required: status === "blocked_with_owner_gate" || budgetExceeded, reason: budgetExceeded ? `Provider budget stopped execution after durable checkpoint in ${overrunPhase}: ${overrunActual} / ${overrunLimit}.` : status === "blocked_with_owner_gate" ? unresolved.join(" ") : null },
      safetyAssertions: { sourceShaUnchanged: sourceAfter === sourceBefore.trim(), sourceWorktreeStateUnchanged: sourceStatusAfter === sourceStatusBefore, targetMainMutation: false, targetMainPush: false, merge: false, deploy: false, publicationPerformed: false, forbiddenZonesRespected: !unresolved.some((item) => item.includes("forbidden")), secretScanPassed: !unresolved.includes("Secret scan rejected the patch.") },
      diagnostics: { agentSummary, sourceBefore: sourceBefore.trim(), sourceAfter, sourceWorktreeStatusBefore: sourceStatusBefore, sourceWorktreeStatusAfter: sourceStatusAfter, dirtyPolicy, contextPlan, selectionReason: selection.reason, rejectedAlternatives: selection.rejected, workspace: relative(request.targetRepository, workspace), ...(noProgress ? { retryPlan: { automatic: false, sameModelProfileAllowed: false, profile: "cheaper-bounded", contextTokens: Math.max(256, Math.floor(request.spec.discovery.maxTokens / 2)), model: "faster-lower-cost", options: ["smaller context", "faster model", "decompose task", "explicit scope", "external-session handoff"], forecastMaxCostUsd: Math.max(0.01, Math.round(actualCostUsd * 125) / 100) } } : {}) },
      localBranch, localCommit, patchPackage, providerCalls, checkpoints,
      budget: { exceeded: budgetExceeded, overrunPhase, requestedTokens: request.spec.execution.maxProviderTokens, actualTokens: totalProviderTokens(providerCalls), accounting: providerCalls.some((item) => item.usageAccounting === "synthetic") ? "synthetic" : "provider", costUsd: actualCostUsd || null },
      selectedExecutor: { id: executor.id, model: executor.model }
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
function localBranchName(taskId: string, generation: string, attempt: number): string {
  const task = refSlug(taskId, "task");
  const execution = refSlug(generation, "standalone");
  const retry = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return `runforge/${task}/${execution}-attempt-${retry}`;
}
function refSlug(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback; }
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
async function stageWorkspaceChanges(workspace: string, intentOnly: boolean): Promise<void> { await git(workspace, ["add", ...(intentOnly ? ["-N"] : ["-A"]), "--", ".", ...RUNFORGE_DEPENDENCY_PATHS]); }
async function filteredWorkspaceDiff(workspace: string, baseSha: string, options: string[]): Promise<string> { return git(workspace, ["diff", ...options, baseSha, "--", ".", ...RUNFORGE_DEPENDENCY_PATHS]); }
function validateChangedPaths(files: string[], zones: string[], max: number): string[] { const errors: string[] = []; if (files.length > max) errors.push(`Changed files exceed limit ${max}.`); const pathZones = zones.filter((zone) => !/\s/.test(zone)).map((zone) => zone.replace(/^\.\//, "").replace(/\*\*|\*/g, "").replace(/\/$/, "")); for (const file of files) { if (file.startsWith("../") || file.startsWith("/")) errors.push(`Path escapes workspace: ${file}.`); const zone = pathZones.find((item) => item && (file === item || file.startsWith(`${item}/`))); if (zone) errors.push(`Changed path is forbidden: ${file} (${zone}).`); } return errors; }
function unsafeDirtyLines(status: string): string[] { return lines(status).filter((line) => { const path = line.slice(3).replace(/^"|"$/g, ""); return !path.startsWith(".runforge/") && !path.startsWith(".runforge-") && !path.startsWith("artifacts/"); }); }
function configuredProviderCapabilities(executor: ImplementationExecutorCapability): ProviderCapabilities {
  let configured: Record<string, any> = {};
  try { configured = JSON.parse(process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES ?? "{}"); } catch { throw new Error("invalid_provider_capabilities_json"); }
  const guarantees = configured.guarantees ?? {};
  return {
    maxInputContextTokens: optionalPositive(configured.maxInputContextTokens) ?? executor.maxLimits.providerTokens,
    maxOutputTokens: optionalPositive(configured.maxOutputTokens) ?? executor.maxLimits.providerTokens,
    maxReasoningTokens: optionalPositive(configured.maxReasoningTokens) ?? executor.maxLimits.providerTokens,
    maxWallClockMs: optionalPositive(configured.maxWallClockMs) ?? executor.maxLimits.timeoutMs,
    maxCallsPerPhase: optionalPositive(configured.maxCallsPerPhase) ?? Math.max(1, executor.maxLimits.repairIterations + 1),
    maxCostUsd: optionalPositive(configured.maxCostUsd),
    guarantees: { inputTokens: guarantees.inputTokens !== false, outputTokens: guarantees.outputTokens !== false, reasoningTokens: guarantees.reasoningTokens !== false, wallClock: guarantees.wallClock !== false, calls: guarantees.calls !== false, cost: guarantees.cost !== false },
  };
}
function assertMandatoryProviderCaps(capability: ProviderCapabilities, request: ImplementationExecutorRequest): void {
  const mandatory: Array<[keyof ProviderCapabilities["guarantees"], string]> = [["inputTokens", "input"], ["outputTokens", "output"], ["reasoningTokens", "reasoning"], ["wallClock", "wall-clock"], ["calls", "call"]];
  if (optionalPositive((request.spec.execution as unknown as Record<string, unknown>).maxCostUsd) !== null) mandatory.push(["cost", "cost"]);
  const missing = mandatory.filter(([key]) => !capability.guarantees[key]).map(([, name]) => name);
  if (missing.length) throw new Error(`provider_capability_rejected: mandatory ${missing.join(", ")} limits are not guaranteed`);
}
function deriveExecutionEnvelope(request: ImplementationExecutorRequest, executor: ImplementationExecutorCapability, capability: ProviderCapabilities, phase: "implementation" | "repair", call: number, phaseTokens: number, taskTokens: number, taskTimeMs: number, remainingCostUsd: number | null): ExecutionEnvelope {
  const execution = request.spec.execution as unknown as Record<string, unknown>;
  const output = Math.min(optionalPositive(execution.maxOutputTokens) ?? phaseTokens, capability.maxOutputTokens, phaseTokens, taskTokens);
  const reasoning = Math.min(optionalPositive(execution.maxReasoningTokens) ?? output, capability.maxReasoningTokens, output);
  return { profile: request.spec.discovery.profile, model: executor.model, taskId: request.spec.taskId, phase, call, limits: { maxInputContextTokens: Math.min(request.spec.discovery.maxTokens, capability.maxInputContextTokens), maxOutputTokens: output, maxReasoningTokens: reasoning, maxWallClockMs: Math.min(request.spec.execution.timeoutMs, capability.maxWallClockMs, taskTimeMs), maxCallsPerPhase: Math.min(optionalPositive(execution.maxCallsPerPhase) ?? 1, capability.maxCallsPerPhase), maxPhaseTokens: request.spec.execution.phaseBudgets[phase], maxTaskTokens: request.spec.execution.maxProviderTokens, maxCostUsd: remainingCostUsd === null ? null : Math.min(remainingCostUsd, capability.maxCostUsd ?? remainingCostUsd) }, remaining: { phaseTokens, taskTokens, taskTimeMs, costUsd: remainingCostUsd } };
}
function truncatePrompt(prompt: string, maxTokens: number): string { const maxChars = Math.max(1, Math.floor(maxTokens * 4)); if (prompt.length <= maxChars) return prompt; const marker = "\n[bounded context truncated]\n"; const head = Math.max(0, Math.floor((maxChars - marker.length) * 0.6)); const tail = Math.max(0, maxChars - marker.length - head); return prompt.slice(0, head) + marker + prompt.slice(-tail); }
function optionalPositive(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function totalProviderTokens(calls: Array<Record<string, unknown>>): number { return calls.reduce((sum, item) => sum + numeric(item.tokenUsage), 0); }
function buildPrompt(request: ImplementationExecutorRequest, iteration: number, validations: CommandDiagnostic[]): string { const context = request.spec.discovery.explicitFiles; return [`You are the RunForge bounded implementation executor. Work only in the current disposable Git worktree.`, `Task: ${request.spec.task.text}`, `Goal: ${request.spec.task.goal}`, `Acceptance criteria:\n${request.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, `Bounded context profile: ${request.spec.discovery.profile}; max ${request.spec.discovery.maxFiles} files, ${request.spec.discovery.maxBytes} bytes, approximately ${request.spec.discovery.maxTokens} tokens. Start with only these explicit files:\n${context.length ? context.map((item) => `- ${item}`).join("\n") : "- Files named by the task and validation commands"}\nStop condition: ${request.spec.discovery.stopCondition}\nDo not enumerate or read the full repository/governance corpus. If context must expand, state the exact file and reason first.`, `Forbidden zones:\n${request.forbiddenZones.map((item) => `- ${item}`).join("\n")}`, `Validation commands:\n${request.validationProfile.commands.map((item) => `- ${item}`).join("\n")}`, `Provider token budget: at most ${request.spec.execution.maxProviderTokens} total and ${request.spec.execution.phaseBudgets[iteration === 0 ? "implementation" : "repair"]} for this phase.`, `Iteration: ${iteration}. ${iteration ? `Repair these failures:\n${validations.filter((item) => item.exitCode !== 0).map((item) => `${item.command}\nstdout: ${item.stdout}\nstderr: ${item.stderr}`).join("\n")}` : "Inspect, plan, implement, and add/update tests as required."}`, `Do not create a Git commit; leave changes uncommitted so RunForge can validate and create the final local commit.`, `Do not push, open a PR, merge, deploy, access secrets/DB/production, or modify forbidden paths. Do not merely propose a patch: edit files and validate. If no change is required, say exactly 'no change required' with evidence. If semantics are ambiguous, stop and say 'ambiguous product decision'.`].join("\n\n"); }

async function buildContextPlan(request: ImplementationExecutorRequest, root: string): Promise<Record<string, unknown>> {
  const mentioned = request.spec.task.text.match(/(?:src|tests|scripts|schemas|docs|config)\/[A-Za-z0-9._/-]+/g) ?? [];
  const files = [...new Set([...request.spec.discovery.explicitFiles, ...mentioned])].slice(0, request.spec.discovery.maxFiles);
  const reads = await Promise.all(files.map(async (file) => { const path = resolve(root, file); if (!isInside(root, path)) return { file, status: "rejected", reason: "path escapes workspace" }; const bytes = await readFile(path).then((value) => value.byteLength, () => 0); return { file, status: bytes ? "planned" : "missing_or_new", bytes, reason: "explicit task scope" }; }));
  const totalBytes = reads.reduce((sum, item) => sum + ("bytes" in item && typeof item.bytes === "number" ? item.bytes : 0), 0);
  return { schemaVersion: 1, profile: request.spec.discovery.profile, limits: { maxFiles: request.spec.discovery.maxFiles, maxBytes: request.spec.discovery.maxBytes, maxTokens: request.spec.discovery.maxTokens }, reads, deduplicated: true, totalFiles: reads.length, totalBytes, withinBounds: reads.length <= request.spec.discovery.maxFiles && totalBytes <= request.spec.discovery.maxBytes, stopCondition: request.spec.discovery.stopCondition, expansionPolicy: "Every additional file requires an explicit reason in provider evidence." };
}

async function runAgent(commandText: string, model: string | null, cwd: string, prompt: string, envelope: ExecutionEnvelope, signal: AbortSignal | undefined, root: string, iteration: number, onUsefulProgress: (signals: ProgressSignals) => Promise<void>): Promise<{ startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null; summary: string; cancelled: boolean; timedOut: boolean; noProgress: boolean; stdout: string; stderr: string; truncation: { stdout: boolean; stderr: boolean; limitBytes: number }; failureReason: string | null; tokenUsage: number | null; costUsd: number | null; progressSignals: ProgressSignals; stdoutArtifact: string; stderrArtifact: string }> {
  const argv = splitCommand(commandText); const command = argv.shift()!; const isCodex = /(?:^|\/)codex$/.test(command);
  const args = isCodex ? [...argv, "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", cwd, ...(model ? ["--model", model] : []), prompt] : argv;
  const started = Date.now(), startedAt = new Date(started).toISOString(); let stdout = "", stderr = "", timedOut = false, cancelled = false, noProgress = false, pendingLine = "";
  const signals: ProgressSignals = { filesInspected: [], exactDiagnosis: null, redTest: null, candidateDiff: null, partialPatch: null, tests: [], lastMeaningfulOutput: null, usage: { tokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null } };
  let progressWork = Promise.resolve(); let useful = false;
  const stdoutArtifact = `provider/iteration-${iteration}.stdout.log`, stderrArtifact = `provider/iteration-${iteration}.stderr.log`;
  await mkdir(join(root, "provider"), { recursive: true });
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: [isCodex ? "ignore" : "pipe", "pipe", "pipe"], env: { ...safeRuntimeEnv(), RUNFORGE_IMPLEMENTATION_REQUEST: join(root, "task-spec.normalized.json"), RUNFORGE_IMPLEMENTATION_PROMPT: prompt, RUNFORGE_EXECUTION_ENVELOPE: JSON.stringify(envelope), RUNFORGE_NETWORK_POLICY: "provider-only" } });
    if (!isCodex) { child.stdin?.end(prompt); }
    const stop = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, envelope.limits.maxWallClockMs);
    const configuredEarly = optionalPositive(process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS) ?? 90_000;
    const earlyTimer = setTimeout(() => { if (!useful) { noProgress = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); } }, Math.min(configuredEarly, envelope.limits.maxWallClockMs));
    const consume = (line: string) => {
      if (!line.trim()) return;
      let item: Record<string, any>; try { item = JSON.parse(line); } catch { return; }
      const message = String(item.msg?.message ?? item.message ?? item.text ?? item.item?.text ?? ""); const type = String(item.type ?? item.event ?? "").toLowerCase();
      const file = typeof item.file === "string" ? item.file : null;
      if (file && /inspect|read|file/.test(type)) signals.filesInspected = [...new Set([...signals.filesInspected, file])];
      if ((file && Number.isFinite(item.line) && /diagnos|root.?cause|exact/.test(`${type} ${message}`)) || /(?:src|tests?)\/[\w./-]+:\d+.*(?:diagnos|cause|fails?)/i.test(message)) signals.exactDiagnosis = message || `${file}:${item.line}`;
      if ((item.status === "red" || /\bred test\b/i.test(message)) && /test|red/.test(type + " " + message.toLowerCase())) signals.redTest = message || `${file ?? "test"}:${item.line ?? "?"}`;
      if (/candidate[_ .-]?(?:diff|change)|file_change/.test(type + " " + message.toLowerCase())) signals.candidateDiff = message || file || type;
      if (/partial[_ .-]?patch/.test(type + " " + message.toLowerCase())) signals.partialPatch = message || file || type;
      if (/test/.test(type) && message) signals.tests = [...new Set([...signals.tests, message])];
      const usage = usageFromEvent(item); for (const key of ["tokens", "inputTokens", "outputTokens", "reasoningTokens", "costUsd"] as const) if (usage[key] !== null) signals.usage[key] = Math.max(signals.usage[key] ?? 0, usage[key]);
      const isUseful = Boolean(signals.filesInspected.length || signals.exactDiagnosis || signals.redTest || signals.candidateDiff || signals.partialPatch || signals.tests.length);
      if (isUseful) { useful = true; signals.lastMeaningfulOutput = message || line.slice(0, 2_000); clearTimeout(earlyTimer); progressWork = progressWork.then(() => onUsefulProgress(structuredClone(signals))); }
    };
    child.stdout?.on("data", (chunk) => { const text = String(chunk); if (Buffer.byteLength(stdout) < 2_000_000) stdout += text; const complete = (pendingLine + text).split(/\r?\n/); pendingLine = complete.pop() ?? ""; for (const line of complete) consume(line); }); child.stderr?.on("data", (chunk) => { if (Buffer.byteLength(stderr) < 2_000_000) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, childSignal) => { clearTimeout(timer); clearTimeout(earlyTimer); if (pendingLine) consume(pendingLine); signal?.removeEventListener("abort", stop); const finishedAt = new Date().toISOString(); const safeStdout = redactProviderOutput(stdout), safeStderr = redactProviderOutput(stderr); const normalizedExit = timedOut || noProgress ? null : exitCode; const failureReason = normalizedExit === 0 ? null : noProgress ? `no_progress: no useful provider signal before ${Math.min(configuredEarly, envelope.limits.maxWallClockMs)}ms.` : timedOut ? `Implementation provider timed out after ${envelope.limits.maxWallClockMs}ms.` : cancelled ? "Implementation provider was cancelled." : safeStdout.trim() || safeStderr.trim() ? `Implementation provider exited with code ${normalizedExit ?? "signal"}.` : "Implementation provider exited non-zero without stdout or stderr."; void progressWork.then(() => Promise.all([writeFile(join(root, stdoutArtifact), safeStdout), writeFile(join(root, stderrArtifact), safeStderr)])).then(() => resolveRun({ startedAt, finishedAt, durationMs: Date.now() - started, exitCode: normalizedExit, signal: childSignal, summary: extractSummary(safeStdout, safeStderr), cancelled, timedOut, noProgress, stdout: safeStdout, stderr: safeStderr, truncation: { stdout: Buffer.byteLength(stdout) >= 2_000_000, stderr: Buffer.byteLength(stderr) >= 2_000_000, limitBytes: 2_000_000 }, failureReason, tokenUsage: signals.usage.tokens ?? extractTokenUsage(safeStdout), costUsd: signals.usage.costUsd, progressSignals: signals, stdoutArtifact, stderrArtifact }), reject); });
  });
}
function usageFromEvent(item: Record<string, any>): ProgressSignals["usage"] { const usage = item.usage ?? item.token_usage ?? item.item?.usage; if (!usage) return { tokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null }; const input = usage.input_tokens ?? usage.inputTokens, cached = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0, output = usage.output_tokens ?? usage.outputTokens, reasoning = usage.reasoning_tokens ?? usage.reasoningTokens; const explicit = usage.total_tokens ?? usage.totalTokens ?? item.total_tokens; const tokens = Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached) ? Math.max(0, Number(input) - Number(cached)) + Number(output) : Number.isFinite(explicit) ? Number(explicit) : null; const cost = usage.cost_usd ?? usage.costUsd ?? item.cost_usd; return { tokens, inputTokens: Number.isFinite(input) ? Math.max(0, Number(input) - Number(cached)) : null, outputTokens: Number.isFinite(output) ? Number(output) : null, reasoningTokens: Number.isFinite(reasoning) ? Number(reasoning) : null, costUsd: Number.isFinite(cost) ? Number(cost) : null }; }
function extractSummary(stdout: string, stderr: string): string { const finals = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const text = item.msg?.message ?? item.message ?? item.text ?? item.item?.text; return typeof text === "string" ? [text] : []; } catch { return []; } }); return (finals.at(-1) ?? stdout ?? stderr).slice(-20_000); }
export function extractTokenUsage(stdout: string): number | null { const values = stdout.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line) as Record<string, any>; const usage = item.usage ?? item.token_usage ?? item.item?.usage; const input = usage?.input_tokens ?? usage?.inputTokens, cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0, output = usage?.output_tokens ?? usage?.outputTokens; if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(cached)) return [Math.max(0, Number(input) - Number(cached)) + Number(output)]; const explicit = usage?.total_tokens ?? usage?.totalTokens ?? item.total_tokens; return Number.isFinite(explicit) ? [Number(explicit)] : []; } catch { return []; } }); return values.length ? Math.max(...values) : null; }
async function runValidation(command: string, cwd: string, root: string, iteration: number, index: number, timeoutMs: number, signal?: AbortSignal): Promise<CommandDiagnostic> { const started = Date.now(), startedAt = new Date(started).toISOString(); let stdout = "", stderr = "", timedOut = false, setupFailure = false; const artifactPath = `validation/iteration-${iteration}/command-${index}.json`; await mkdir(dirname(join(root, artifactPath)), { recursive: true }); return new Promise((resolveRun) => { const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: safeRuntimeEnv() }); const stop = () => child.kill("SIGTERM"); signal?.addEventListener("abort", stop, { once: true }); const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs); child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; }); child.on("error", (error) => { setupFailure = true; stderr += error.message; }); child.on("close", (exitCode, childSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); const finishedAt = new Date().toISOString(); stdout = redactProviderOutput(stdout); stderr = redactProviderOutput(stderr); const stdoutTruncated = Buffer.byteLength(stdout) > 1_000_000, stderrTruncated = Buffer.byteLength(stderr) > 1_000_000; const diagnosticGap = exitCode !== 0 && !stdout.trim() && !stderr.trim(); const failureReason = exitCode === 0 ? null : timedOut ? `Validation timed out after ${timeoutMs}ms.` : setupFailure ? "Validation command could not be started." : diagnosticGap ? "Validation exited non-zero without stdout or stderr." : `Validation command exited with code ${exitCode ?? "signal"}.`; const classification = exitCode === 0 ? null : setupFailure ? "setup" as const : timedOut || childSignal ? "runtime" as const : diagnosticGap ? "infrastructure" as const : "product" as const; const diagnostic: CommandDiagnostic = { command, cwd, executor: "local-coding-agent", runtime: "local-disposable", startedAt, finishedAt, durationMs: Date.now() - started, exitCode, signal: childSignal, stdout: stdout.slice(0, 1_000_000), stderr: stderr.slice(0, 1_000_000), stdoutTruncated, stderrTruncated, truncation: { stdout: stdoutTruncated, stderr: stderrTruncated, limitBytes: 1_000_000 }, artifactPaths: [artifactPath], timedOut, setupFailure, failureReason, classification, diagnosticGap, infrastructureDefect: diagnosticGap ? "non-zero exit produced empty stdout and stderr" : null, artifactPath }; void writeFile(join(root, artifactPath), JSON.stringify(diagnostic, null, 2) + "\n").then(() => resolveRun(diagnostic)); }); }); }
function safeRuntimeEnv(): NodeJS.ProcessEnv { const allowed = ["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]; return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])); }
function redactProviderOutput(value: string): string { return value.replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]").replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"); }
