import { createHash, randomUUID } from "node:crypto";
import { access, cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { buildDoctorReport } from "../product/doctor.js";
import { runTaskSpecFile } from "../product/task-spec-runner.js";
import { loadTaskSpecV2 } from "../product/task-spec-v2.js";
import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor, taskRuntimeIds } from "../product/task-spec-contract.js";
import { continueExternalExecution, recordOwnerDecision } from "../run/external-execution.js";
import { ControlPlaneError, type AgreementLifecycleProjection, type ControlAuthority, type ControlTaskRecord, type DecisionRecord, type ProjectRecord } from "./contracts.js";
import { ControlPlaneStore } from "./state.js";
import { discoverImplementationExecutors, selectImplementationExecutor } from "../implementation/executor.js";
import type { ExecutionAgreement } from "../product/execution-agreement.js";
import type { ExecutionAgreementContext } from "../product/execution-agreement.js";
import { inspectProject } from "../product/project-inspection.js";
import {
  assertAgreementAccepted,
  assertAgreementMatchesTask,
  negotiateControlPlaneAgreement,
  negotiateTaskAgreement,
  technicalCapabilitiesForExecutor,
  type ExecutionAgreementNegotiationRequest,
} from "./execution-agreements.js";

const executionTimeoutMs = implementationExecutorContract.maxLimits.timeoutMs;
const heartbeatIntervalMs = 1_000;
const staleHeartbeatMs = 15_000;
const cleanupGraceMs = 2_000;

function agreementHardBoundaries(): string[] {
  return [
    "No GitHub or GitLab push, PR/MR creation, or existing-change update adapter is available.",
    "No CI, merge, deploy, database, production, or secret adapter is available.",
    "Request maps may only narrow installation capability, authority, and policy.",
    "RUNFORGE.md supplies project defaults only and cannot grant authority or relax hard boundaries.",
  ];
}

type ActiveWorker = { executionId: string; operation: "execution" | "continuation"; cancelled: boolean; controller: AbortController };
type ContinuationBinding = { taskId: string; projectId: string | null; repository: string; workingDirectory: string; sourceBranch: string; sourceSha: string };

export class ControlPlaneManager {
  private readonly active = new Map<string, ActiveWorker>();
  private readonly settledExecutions = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly journalHeartbeats = new Map<string, number>();
  private watchdog: NodeJS.Timeout | null = null;
  constructor(
    public readonly store: ControlPlaneStore,
    private readonly operations: { runTaskSpec: typeof runTaskSpecFile; recordOwnerDecision: typeof recordOwnerDecision; continueExecution: typeof continueExternalExecution } = { runTaskSpec: runTaskSpecFile, recordOwnerDecision, continueExecution: continueExternalExecution },
    private readonly timing: { heartbeatIntervalMs: number; staleHeartbeatMs: number; executionTimeoutMs: number; cleanupGraceMs?: number } = { heartbeatIntervalMs, staleHeartbeatMs, executionTimeoutMs, cleanupGraceMs }
  ) {}

  async initialize(): Promise<void> { await this.store.initialize(); this.watchdog ??= setInterval(() => void this.watchdogTick(), Math.min(this.timing.staleHeartbeatMs, 5_000)); this.watchdog.unref(); }
  close(): void { if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null; for (const worker of this.active.values()) worker.controller.abort(); this.active.clear(); }

  async inspectProject(input: { path: string; workingDirectory: string; register: boolean; runtime?: "local" | "docker"; dependencyPreparation?: "required" | "if-needed" | "disabled" | "reuse-existing" }): Promise<Record<string, unknown>> {
    const report = await buildDoctorReport({ repo: input.path, workingDirectory: input.workingDirectory, runtime: input.runtime, dependencyPreparation: input.dependencyPreparation, publication: "none" });
    let project: ProjectRecord | null = null;
    if (input.register && report.targetRepository?.repositoryRoot && report.targetRepository.workingDirectory) {
      const now = new Date().toISOString(); const repository = await realpath(report.targetRepository.repositoryRoot);
      const existing = (await this.store.listProjects()).find((item) => item.repository === repository && item.workingDirectory === report.targetRepository!.workingDirectory);
      project = { id: this.store.projectId(repository, report.targetRepository.workingDirectory), repository, workingDirectory: report.targetRepository.workingDirectory, createdAt: existing?.createdAt ?? now, updatedAt: now }; await this.store.saveProject(project);
    }
    return { project, readiness: { ...report, checks: report.checks.map((item) => item.id === "implementation_executor" && item.status !== "passed" ? { ...item, summary: "Implementation executor or its existing credential mechanism is not ready; no credential data is exposed." } : item), implementationExecutors: report.implementationExecutors.map((item) => ({ id: item.id, status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime, providerRequirements: item.providerRequirements, networkRequirements: item.networkRequirements, maxLimits: item.maxLimits, model: item.model, credentialReady: item.status === "ready", limitations: item.status === "ready" ? [] : ["Implementation executor or its existing credential mechanism is not ready; no credential data is exposed."] })) } };
  }

  async negotiateAgreement(input: ExecutionAgreementNegotiationRequest): Promise<ExecutionAgreement> {
    const project = input.projectId ? await this.requireProject(input.projectId) : null;
    const [executors, context] = await Promise.all([discoverImplementationExecutors(), this.executionAgreementContext(project, input.publicationTarget ?? { kind: "none" })]);
    const agreement = negotiateControlPlaneAgreement(input, technicalCapabilitiesForExecutor(executors.some((item) => item.status === "ready")), context);
    await this.store.saveAgreement(agreement);
    return agreement;
  }

  async getAgreement(id: string): Promise<ExecutionAgreement> {
    const agreement = await this.store.getAgreement(id);
    if (!agreement) throw new ControlPlaneError(404, "execution_agreement_not_found", `Execution Agreement not found: ${id}`);
    return agreement;
  }

  async getTaskAgreement(id: string): Promise<ExecutionAgreement> {
    const task = await this.readTask(id);
    if (!task.executionAgreement) throw new ControlPlaneError(404, "task_execution_agreement_not_found", `Task has no persisted Execution Agreement: ${id}`, undefined, false, id);
    return task.executionAgreement;
  }

  async createTask(input: { projectId?: string; taskSpec: Record<string, unknown>; authority: ControlAuthority; publicationRequested: "none" | "draft-pr"; agreementId?: string }): Promise<ControlTaskRecord> {
    const raw = structuredClone(input.taskSpec); const project = input.projectId ? await this.requireProject(input.projectId) : null; const taskId = requiredString(raw.taskId, "taskSpec.taskId");
    if (await this.store.getTask(taskId)) throw new ControlPlaneError(409, "task_exists", `Task already exists: ${taskId}`, undefined, false, taskId);
    if (!input.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a task.");
    if (project) raw.target = { repository: project.repository, workingDirectory: project.workingDirectory }; if (!raw.target) throw new ControlPlaneError(422, "project_required", "Provide projectId or taskSpec.target.");
    const requestedMode = object(raw.execution).mode;
    if (implementationExecutorContract.modes.includes(requestedMode)) {
      const runtime = object(raw.runtime); const requestedRuntime = runtime.preference;
      if (requestedRuntime !== undefined && (typeof requestedRuntime !== "string" || !runtimeCompatibleWithImplementationExecutor(requestedRuntime))) {
        const correctedTaskSpec = structuredClone(raw); correctedTaskSpec.runtime = { ...runtime, preference: implementationExecutorContract.defaultRuntime };
        throw new ControlPlaneError(422, "runtime_incompatible", `${implementationExecutorContract.id} does not support runtime '${String(requestedRuntime)}'; use '${implementationExecutorContract.defaultRuntime}'.`, {
          executorId: implementationExecutorContract.id,
          requestedMode,
          requestedRuntime,
          allowedValues: taskRuntimeIds,
          compatibleRuntimes: implementationExecutorContract.runtimes,
          documentedDefault: implementationExecutorContract.defaultRuntime,
          correctedRequest: { ...(input.projectId ? { projectId: input.projectId } : {}), taskSpec: correctedTaskSpec, authority: input.authority, publication: input.publicationRequested },
          operation: "start_new_task",
          newTaskRequired: true
        }, false, taskId);
      }
      raw.runtime = { ...runtime, preference: requestedRuntime ?? implementationExecutorContract.defaultRuntime };
    }
    const requestedInSpec = object(raw.git).publication; const publicationRequested = input.publicationRequested === "draft-pr" || requestedInSpec === "draft-pr" ? "draft-pr" : "none";
    raw.git = { publication: "none" }; raw.merge = { policy: "never" }; raw.deploy = { policy: "never" }; const artifactRoot = join(this.store.taskDir(taskId), "attempts", "1", "artifacts"); raw.artifacts = { ...object(raw.artifacts), root: artifactRoot, resultFormat: "normalized-v1" };
    let specPath = await this.store.writeSpec(taskId, raw); let normalized: Awaited<ReturnType<typeof loadTaskSpecV2>>; try { normalized = await loadTaskSpecV2(specPath); } catch (error) { throw new ControlPlaneError(422, "invalid_task_spec", safeMessage(error), { operation: "start_new_task", newTaskRequired: true }); }
    raw.target = { ...object(raw.target), repository: normalized.target.repository, workingDirectory: normalized.target.workingDirectory, expectedSha: normalized.target.expectedSha };
    specPath = await this.store.writeSpec(taskId, raw);
    const implementation = ["implementation", "repair"].includes(normalized.execution.mode);
    const automaticContext = project ? await this.executionAgreementContext(project, { kind: "none" }) : undefined;
    const preflightAgreement = negotiateTaskAgreement(normalized, input.authority, automaticContext);
    const executionAgreement = input.agreementId ? await this.getAgreement(input.agreementId) : preflightAgreement;
    await this.assertAgreementProjectBinding(executionAgreement, project, taskId);
    const delegatedImplementation = implementationParty(executionAgreement);
    if (!delegatedImplementation && implementation && !input.authority.implementation) throw preflightError("implementation_authority_denied", "Implementation mode requires control-plane implementation authority.", normalized, input.authority);
    if (!delegatedImplementation && normalized.authority.allowProviderCalls && input.authority.providerCalls !== true) throw preflightError("provider_authority_denied", "TaskSpec allows provider calls but control-plane providerCalls authority is false.", normalized, input.authority);
    if (!delegatedImplementation && (normalized.authority.allowNetwork || normalized.runtime.externalNetwork === "allowed") && input.authority.network !== true) throw preflightError("network_authority_denied", "TaskSpec allows network but control-plane network authority is false.", normalized, input.authority);
    if (!delegatedImplementation && implementation && !normalized.authority.allowProviderCalls) throw preflightError("provider_permission_denied", "The implementation executor requires TaskSpec authority.allowProviderCalls=true.", normalized, input.authority);
    if (!delegatedImplementation && implementation && (!normalized.authority.allowNetwork || normalized.runtime.externalNetwork !== "allowed")) throw preflightError("network_permission_denied", "The implementation executor requires authority.allowNetwork=true and runtime.externalNetwork='allowed'.", normalized, input.authority);
    if (runforgeOwns(executionAgreement, "localBranch") && !input.authority.localBranch) throw preflightError("mutation_authority_denied", "The effective agreement requires localBranch authority for the RunForge-owned localBranch phase.", normalized, input.authority);
    if (runforgeOwns(executionAgreement, "localCommit") && !input.authority.localCommit) throw preflightError("local_commit_authority_denied", "The effective agreement requires localCommit authority for the RunForge-owned localCommit phase.", normalized, input.authority);
    assertAgreementAccepted(executionAgreement, taskId);
    assertAgreementMatchesTask(executionAgreement, normalized, preflightAgreement);
    await this.store.saveAgreement(executionAgreement);
    const selected = implementation && !delegatedImplementation ? await selectImplementationExecutor(normalized) : null;
    if (selected && !selected.selected) throw new ControlPlaneError(503, "implementation_executor_unavailable", selected.reason, { requestedMode: normalized.execution.mode, availableExecutors: selected.rejected.map((item) => item.id), rejectedAlternatives: selected.rejected, authorityFailures: [], operation: "start_new_task", newTaskRequired: true }, true, taskId);
    const effectiveTimeoutMs = Math.min(normalized.execution.timeoutMs, this.timing.executionTimeoutMs, implementationExecutorContract.maxLimits.timeoutMs);
    const now = new Date().toISOString(); const task: ControlTaskRecord = {
      id: taskId, projectId: project?.id ?? null, status: "queued", specPath, artifactRoot, executionAgreement, authority: input.authority, publicationRequested,
      publicationGate: publicationRequested === "draft-pr" ? { required: true, status: "blocked_until_implementation_completes", reason: "Remote publication is a separate decision." } : { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" },
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, error: null, decisions: [], events: [], progress: progress(now, effectiveTimeoutMs), recovery: null,
      execution: { attempt: 0, lease: null, attempts: [], lastRetry: null }, continuation: { schemaVersion: 1, state: "none", decisionId: null, executionId: null, sourceExecutionId: null },
      selection: { requestedMode: normalized.execution.mode, normalizedMode: normalized.execution.mode, selectedExecutor: delegatedImplementation ? "agreement-handoff" : selected?.selected?.id ?? (normalized.execution.mode === "validation" ? "validation-lane" : "inspection-lane"), selectedRuntime: delegatedImplementation ? null : normalized.runtime.preference, selectionReason: delegatedImplementation ? `The effective Execution Agreement delegates implementation to ${delegatedImplementation}; RunForge will perform agreement/discovery work and settle a handoff without selecting a coding agent.` : selected?.reason ?? `Explicit ${normalized.execution.mode} mode uses its dedicated lane.`, rejectedAlternatives: selected?.rejected ?? [], authorityChecks: { inspect: input.authority.inspect, implementation: Boolean(delegatedImplementation) || !implementation || input.authority.implementation, providerCalls: Boolean(delegatedImplementation) || !normalized.authority.allowProviderCalls || input.authority.providerCalls === true, network: Boolean(delegatedImplementation) || !normalized.authority.allowNetwork || input.authority.network === true, localBranch: !runforgeOwns(executionAgreement, "localBranch") || input.authority.localBranch, localCommit: !runforgeOwns(executionAgreement, "localCommit") || input.authority.localCommit, publicationForbidden: normalized.git.publication === "none" }, providerDecision: delegatedImplementation ? "not_requested" : normalized.authority.allowProviderCalls ? "allowed" : "not_requested", networkDecision: delegatedImplementation ? "not_requested" : normalized.runtime.externalNetwork === "allowed" ? "allowed" : "denied", provider: selected?.selected?.providerCalls ? "configured-local-credential" : null, model: selected?.selected?.model ?? null }
    };
    task.progress.agreement = projectAgreementLifecycle(task);
    await this.persist(task, "task_created"); if (publicationRequested === "draft-pr") await this.persist(task, "publication_gate_created", "blocked_until_implementation_completes"); await this.beginAttempt(task, "execution"); return task;
  }

  async getTask(id: string): Promise<ControlTaskRecord> { return this.withLock(id, async () => {
    const task = await this.readTask(id); await this.advanceRecovery(task);
    if (task.status === "failed" && !task.recovery) {
      task.recovery = { reason: "execution_failed", lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: task.progress.executionId, actions: ["start_new_task"], retryAvailable: false, cleanupStatus: "completed", operation: "start_new_task", prerequisites: ["Correct the reported failure.", "Submit a current TaskSpec v2."], newTaskRequired: true, previousArtifactsReusable: true, targetShaChanged: null };
      await this.store.saveTask(task);
    }
    return task;
  }); }
  async getResult(id: string): Promise<Record<string, unknown>> { const task = await this.getTask(id); let published = await this.store.readPublishedResult(id); if (!published && task.status === "interrupted") { await this.writeInterruptedResult(task); published = await this.store.readPublishedResult(id); } if (!published || published.executionId !== task.progress.executionId) throw new ControlPlaneError(404, "result_not_ready", `Result is not available for active execution ${task.progress.executionId ?? "pending"}.`, undefined, true, id); const bounded = boundPublicResult(published.result); const agreement = projectAgreementLifecycle(task, published.result); return { ...bounded.result, ...(task.recovery ? { recovery: task.recovery } : {}), controlPlane: { status: task.status, progress: { ...task.progress, agreement }, agreement, ...(task.executionAgreement ? { executionAgreement: task.executionAgreement } : {}), recovery: task.recovery, ownerGate: task.ownerGate, publicationGate: task.publicationGate, authority: task.authority, ...(bounded.truncatedFields.length ? { responseBounds: { truncated: true, maxDiagnosticBytes: publicDiagnosticBytes, maxStringBytes: publicStringBytes, truncatedFields: bounded.truncatedFields } } : {}) } }; }

  async ownerDecision(id: string, input: { decisionId: string; decision: string; targetBranch?: string; note: string }): Promise<Record<string, unknown>> { return this.withLock(id, async () => {
    const task = await this.readTask(id); const duplicate = task.decisions.find((item) => item.kind === "owner" && item.decisionId === input.decisionId);
    if (duplicate) { if (duplicate.decision !== input.decision) throw new ControlPlaneError(409, "idempotency_conflict", "The decision ID was already used for a different decision.", undefined, false, id); return { idempotentReplay: true, ...duplicate.response }; }
    if (task.decisions.some((item) => item.kind === "owner")) throw new ControlPlaneError(409, "owner_decision_conflict", "An owner decision is already recorded.", undefined, false, id);
    if (!task.ownerGate.required) throw new ControlPlaneError(409, "owner_gate_not_open", "This task has no open implementation owner gate.", undefined, false, id);
    if (["approve", "continue"].includes(input.decision) && !task.authority.implementation) throw new ControlPlaneError(403, "authority_denied", "Implementation authority is required.", undefined, false, id);
    await this.ensureContinuationSnapshot(task); if (task.continuation.state === "unrecoverable") { await this.markContinuationUnrecoverable(task); throw new ControlPlaneError(409, "continuation_state_unrecoverable", "Owner decision was not recorded because continuation state cannot be safely reconstructed.", { recoveryActions: task.recovery?.actions }, false, id); } const targetBranch = input.targetBranch ?? `runforge/${task.id.toLowerCase()}`;
    let recorded: { decisionId: string; path: string }; try { recorded = await this.operations.recordOwnerDecision({ run: task.artifactRoot, decision: input.decision, targetMode: "controlled-worktree", targetBranch, ownerNote: input.note }); } catch (error) { throw continuationError(task, error); }
    const response = { decisionId: input.decisionId, runforgeDecisionId: recorded.decisionId, artifact: basename(recorded.path), decision: input.decision, targetBranch };
    task.decisions.push(decisionRecord(input.decisionId, "owner", input.decision, response)); task.continuation.decisionId = input.decisionId; const snapshot = await this.store.readContinuation(id); if (snapshot) await this.store.saveContinuation(id, { ...snapshot, decisionId: input.decisionId }); task.ownerGate = { required: ["approve", "continue"].includes(input.decision), status: input.decision === "reject" ? "rejected" : input.decision === "hold" ? "on_hold" : "decision_recorded" }; task.updatedAt = new Date().toISOString(); await this.persist(task, "owner_decision_recorded", input.decision); return response;
  }); }

  async continueTask(id: string): Promise<ControlTaskRecord> { return this.withLock(id, async () => {
    const task = await this.readTask(id); if (task.continuation.state === "consumed" || task.status === "completed") return task;
    const live = this.liveWorker(task); if (live?.operation === "continuation" || live && ["running", "continuing"].includes(task.status)) return task;
    if (task.status !== "awaiting_owner_decision") throw new ControlPlaneError(409, "task_not_continuable", `Task status '${task.status}' cannot be continued; interrupted attempts must use the advertised retry operation.`, undefined, false, id);
    if (!task.decisions.some((item) => item.kind === "owner" && ["approve", "continue"].includes(item.decision))) throw new ControlPlaneError(409, "owner_decision_required", "An approving owner decision is required.", undefined, false, id);
    if (!(await this.restoreContinuation(task))) { await this.markContinuationUnrecoverable(task); throw new ControlPlaneError(409, "continuation_state_unrecoverable", "Continuation state is missing or corrupt and could not be safely reconstructed.", { recoveryActions: task.recovery?.actions }, false, id); }
    await this.persist(task, "continuation_requested"); await this.beginAttempt(task, "continuation"); return task;
  }); }

  async retryTask(id: string): Promise<ControlTaskRecord> { return this.withLock(id, async () => {
    const task = await this.readTask(id); await this.advanceRecovery(task);
    if (["running", "continuing"].includes(task.status) && task.execution.lastRetry?.executionId === task.progress.executionId) return task;
    if (task.status !== "interrupted") throw new ControlPlaneError(409, "task_not_retryable", `Task status '${task.status}' is not retryable.`, undefined, false, id);
    if (!task.recovery?.retryAvailable) {
      if (task.recovery?.cleanupStatus === "detached") throw new ControlPlaneError(409, "worker_cleanup_failed", "The old worker did not complete cleanup; in-place retry is blocked to prevent overlapping target mutations.", { actions: task.recovery.actions }, false, id);
      throw new ControlPlaneError(409, "recovery_pending", "The previous execution lease is being cleaned up.", { retryAfter: task.recovery?.retryAfter, pollingAction: `/v1/tasks/${id}` }, true, id);
    }
    const sourceExecutionId = task.progress.executionId;
    if (!sourceExecutionId) throw new ControlPlaneError(409, "execution_identity_missing", "Interrupted task has no execution identity.", undefined, false, id);
    const operation = task.continuation.decisionId ? "continuation" : "execution";
    if (!(await this.acceptedSourceIsCurrent(task))) throw new ControlPlaneError(409, "target_sha_changed", "Retry is blocked because the accepted source identity is missing or no longer current; submit a new TaskSpec.", { recoveryActions: task.recovery?.actions }, false, id);
    if (operation === "continuation" && !(await this.restoreContinuation(task))) { await this.markContinuationUnrecoverable(task); throw new ControlPlaneError(409, "continuation_state_unrecoverable", "Interrupted continuation cannot be reconstructed safely.", { recoveryActions: task.recovery?.actions }, false, id); }
    await this.beginAttempt(task, operation, sourceExecutionId);
    return task;
  }); }
  async cancelTask(id: string): Promise<ControlTaskRecord> { return this.withLock(id, async () => { const task = await this.readTask(id); if (["completed", "failed", "interrupted"].includes(task.status)) return task; await this.interrupt(task, "cancelled_by_operator", ["retry"]); task.progress.workerStatus = "cancelled"; task.progress.summary = "Cancelled by operator."; await this.store.saveTask(task); await this.writeInterruptedResult(task); return task; }); }

  async publicationDecision(id: string, input: { decisionId: string; decision: string; note: string }): Promise<Record<string, unknown>> { return this.withLock(id, async () => { const task = await this.readTask(id); const duplicate = task.decisions.find((item) => item.kind === "publication" && item.decisionId === input.decisionId); if (duplicate) return { idempotentReplay: true, ...duplicate.response }; if (!task.publicationGate.required) throw new ControlPlaneError(409, "publication_gate_not_open", "This task has no publication gate."); const permitted = task.authority.remotePush && task.authority.draftPublication; const status = input.decision === "approve" ? permitted ? "approved_adapter_required" : "blocked_missing_authority" : input.decision === "reject" ? "rejected" : "on_hold"; const response = { decisionId: input.decisionId, decision: input.decision, status, executed: false, providerCalls: false, reason: status === "blocked_missing_authority" ? "remotePush and draftPublication authority are required." : "Publication execution is separate." }; task.decisions.push(decisionRecord(input.decisionId, "publication", input.decision, response)); task.publicationGate = { required: status !== "rejected", status, reason: response.reason }; task.updatedAt = new Date().toISOString(); await this.persist(task, "publication_gate_created", status); return response; }); }

  async health(): Promise<Record<string, unknown>> { await this.watchdogTick(); const [tasks, implementationExecutors] = await Promise.all([Promise.all((await this.store.listTasks()).map((task) => this.getTask(task.id))), discoverImplementationExecutors()]); const now = Date.now(); const active = tasks.filter((task) => Boolean(this.liveWorker(task))); const ages = active.map((t) => now - Date.parse(t.progress.lastHeartbeatAt ?? t.updatedAt)); const stalled = tasks.filter((t) => t.progress.workerStatus === "stalled" || t.recovery?.cleanupStatus === "pending" || t.recovery?.cleanupStatus === "detached"); const implementationReady = implementationExecutors.some((item) => item.status === "ready"); return { schemaVersion: 1, service: { status: "healthy", localOnly: true }, readiness: { acceptingNewTasks: true, acceptingImplementationTasks: implementationReady, status: stalled.length || !implementationReady ? "ready_with_degraded_capabilities" : "ready" }, implementationExecutors: implementationExecutors.map((item) => ({ id: item.id, status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime, maxLimits: item.maxLimits, model: item.model, credentialReady: item.status === "ready", reason: item.status === "ready" ? "Existing credential mechanism is ready." : "Implementation executor or its existing credential mechanism is not ready; no credential data is exposed." })), tasks: { active: active.length, cleanupPending: tasks.filter((t) => t.recovery?.cleanupStatus === "pending").length, awaitingOwnerDecisions: tasks.filter((t) => t.status === "awaiting_owner_decision").length, interrupted: tasks.filter((t) => t.status === "interrupted").length, stalled: stalled.length, oldestHeartbeatAgeMs: ages.length ? Math.max(...ages) : 0 } }; }

  private async beginAttempt(task: ControlTaskRecord, operation: "execution" | "continuation", retrySource?: string): Promise<void> {
    const executionId = randomUUID(); const attempt = task.execution.attempt + 1; const now = new Date();
    let artifactRoot = task.artifactRoot; let specPath = task.specPath;
    if (operation === "execution") {
      artifactRoot = join(this.store.taskDir(task.id), "attempts", String(attempt), "artifacts");
      const canonical = structuredClone(await this.store.readSpec(task.id) ?? {}); canonical.artifacts = { ...object(canonical.artifacts), root: artifactRoot, resultFormat: "normalized-v1" };
      specPath = await this.store.writeAttemptSpec(task.id, attempt, canonical);
    } else if (retrySource) {
      const previousRoot = artifactRoot; artifactRoot = join(this.store.taskDir(task.id), "attempts", String(attempt), "artifacts");
      await cp(previousRoot, artifactRoot, { recursive: true, force: true }); await rm(join(artifactRoot, "results.json"), { force: true });
    }
    task.artifactRoot = artifactRoot; task.specPath = specPath; task.status = operation === "continuation" ? "continuing" : "running"; task.startedAt ??= now.toISOString(); task.updatedAt = now.toISOString(); task.finishedAt = null; task.error = null; task.recovery = null;
    const effectiveTimeoutMs = task.progress.timeoutMs;
    task.progress = { phase: operation === "continuation" ? "continuation" : "task_execution", operation, startedAt: now.toISOString(), updatedAt: now.toISOString(), lastHeartbeatAt: now.toISOString(), executionId, attempt, workerStatus: "active", timeoutMs: effectiveTimeoutMs, deadlineAt: new Date(now.getTime() + effectiveTimeoutMs).toISOString(), summary: `${operation} worker active`, diagnostic: "Durable execution lease and worker promise are live.", agreement: task.progress.agreement ?? projectAgreementLifecycle(task) };
    task.execution.attempt = attempt; task.execution.lease = { executionId, attempt, operation, state: "active", startedAt: now.toISOString(), revokedAt: null, cleanupDeadlineAt: null };
    task.execution.attempts.push({ executionId, attempt, operation, artifactRoot, specPath, startedAt: now.toISOString(), finishedAt: null, outcome: "active" });
    this.active.set(task.id, { executionId, operation, cancelled: false, controller: new AbortController() });
    if (retrySource) { task.execution.lastRetry = { sourceExecutionId: retrySource, executionId, requestedAt: now.toISOString() }; await this.persist(task, "retry_requested", `${retrySource}->${executionId}`); }
    if (operation === "continuation") task.continuation.executionId = executionId;
    await this.persist(task, operation === "continuation" ? "continuation_started" : "task_started"); await this.persist(task, "phase_started", task.progress.phase);
    void this.execute(task.id, operation, executionId).finally(() => { if (this.active.get(task.id)?.executionId === executionId) this.active.delete(task.id); });
  }
  private async execute(id: string, operation: "execution" | "continuation", executionId: string): Promise<void> {
    const task = await this.getTask(id); const worker = this.active.get(id); if (!worker || worker.executionId !== executionId || worker.cancelled || task.execution.lease?.executionId !== executionId) return;
    const heartbeat = setInterval(() => void this.heartbeat(id, executionId), this.timing.heartbeatIntervalMs); heartbeat.unref();
    try {
      const rawWork: Promise<unknown> = operation === "continuation" ? this.operations.continueExecution({ run: task.artifactRoot, timeoutMs: task.progress.timeoutMs }) : this.operations.runTaskSpec(task.specPath, { signal: worker.controller.signal, attempt: task.progress.attempt, executionId, onProgress: (phase, detail) => this.updateProgress(id, executionId, phase, detail) });
      const work = rawWork.then((value) => { this.settledExecutions.add(executionId); return value; }, (error) => { this.settledExecutions.add(executionId); throw error; });
      await abortable(work, worker.controller.signal); if (worker.cancelled) return;
      await this.withLock(id, async () => { const current = await this.readTask(id); if (!this.executionIsCurrent(current, executionId)) return; await this.refreshFromResult(current, executionId); });
    }
    catch (error) { const currentWorker = this.active.get(id); if (currentWorker?.executionId === executionId && !currentWorker.cancelled) await this.withLock(id, async () => this.failTask(id, executionId, error)); } finally { clearInterval(heartbeat); }
  }
  private async heartbeat(id: string, executionId: string): Promise<void> { await this.withLock(id, async () => { const worker = this.active.get(id); if (!worker || worker.executionId !== executionId || worker.cancelled) return; const task = await this.readTask(id); if (!["running", "continuing"].includes(task.status) || !this.executionIsCurrent(task, executionId)) return; const now = new Date().toISOString(); task.updatedAt = now; task.progress.updatedAt = now; task.progress.lastHeartbeatAt = now; task.progress.workerStatus = "active"; task.progress.summary = `${task.progress.operation} worker active`; await this.store.saveTask(task); const last = this.journalHeartbeats.get(id) ?? 0; if (Date.now() - last >= 30_000) { await this.store.appendEvent(id, { at: now, type: "heartbeat", detail: task.progress.phase, executionId }); this.journalHeartbeats.set(id, Date.now()); } }); }
  private async updateProgress(id: string, executionId: string, phase: string, detail: string): Promise<void> { await this.withLock(id, async () => { const task = await this.readTask(id); if (!this.executionIsCurrent(task, executionId)) return; const now = new Date().toISOString(); task.progress = { ...task.progress, phase, updatedAt: now, lastHeartbeatAt: now, summary: detail, diagnostic: null }; task.updatedAt = now; await this.persist(task, "phase_started", `${phase}: ${detail}`); }); }
  private async refreshFromResult(task: ControlTaskRecord, executionId: string): Promise<void> { const rawResult = await this.store.readResult(task); if (!rawResult) return this.failTask(task.id, executionId, new Error("RunForge execution finished without results.json.")); const result = task.executionAgreement ? settleAcceptedAgreement(rawResult, task.executionAgreement) : rawResult; const status = String(result.status ?? "failed"); const successful = ["completed", "workflow_completed", "runforge_scope_completed", "awaiting_external_session"].includes(status); task.status = status === "awaiting_owner_decision" || status === "awaiting_owner" || status === "blocked" ? "awaiting_owner_decision" : successful ? "completed" : "failed"; const gate = object(result.ownerGate); task.ownerGate = { required: gate.required === true, status: String(gate.status ?? "unknown"), ...(typeof gate.reason === "string" ? { reason: gate.reason } : {}) }; if (task.status === "awaiting_owner_decision") await this.ensureContinuationSnapshot(task); if (task.status === "completed" && task.continuation.decisionId) task.continuation.state = "consumed"; if (task.status === "completed" && task.publicationRequested === "draft-pr") task.publicationGate = { required: true, status: "awaiting_owner_decision", reason: "Remote publication requires a separate decision." }; task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.progress = { ...task.progress, updatedAt: task.updatedAt, lastHeartbeatAt: task.updatedAt, workerStatus: "finished", summary: `Task ${task.status}.`, diagnostic: "Worker completed and generation-matched results.json was accepted." }; task.progress.agreement = projectAgreementLifecycle(task, result); this.finishAttempt(task, task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "completed"); if (task.execution.lease) task.execution.lease.state = "finished"; await this.store.writePublishedResult(task.id, executionId, result); await this.persist(task, task.status === "completed" ? "task_completed" : task.status === "awaiting_owner_decision" ? "owner_gate_created" : "task_failed", task.status); }
  private async failTask(id: string, executionId: string, error: unknown): Promise<void> { const task = await this.readTask(id); if (!this.executionIsCurrent(task, executionId)) return; task.status = "failed"; task.error = safeMessage(error); task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.progress = { ...task.progress, updatedAt: task.updatedAt, workerStatus: "failed", diagnostic: task.error, summary: "Worker failed." }; task.recovery = { reason: "worker_failed", lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: executionId, actions: ["start_new_task", "cancel"], retryAvailable: false, cleanupStatus: "completed" }; this.finishAttempt(task, "failed"); if (task.execution.lease) task.execution.lease.state = "finished"; await this.store.writePublishedResult(task.id, executionId, { schemaVersion: 1, taskId: task.id, status: "failed", lastCompletedPhase: task.progress.phase, error: task.error, execution: { id: executionId, attempt: task.progress.attempt, operation: task.progress.operation }, artifacts: { root: task.artifactRoot }, recovery: task.recovery, safetyAssertions: { successNotInferred: true, lateWorkerResultIgnored: true }, nextAction: "Inspect the failed attempt evidence and start a new task." }); await this.persist(task, "task_failed", task.error); }
  private async interrupt(task: ControlTaskRecord, reason: string, actions: string[]): Promise<void> {
    const now = new Date(); const executionId = task.progress.executionId; const live = this.liveWorker(task); const pending = Boolean(live && !this.settledExecutions.has(executionId ?? ""));
    if (live) { live.cancelled = true; live.controller.abort(); this.active.delete(task.id); }
    const retryAfter = pending ? new Date(now.getTime() + (this.timing.cleanupGraceMs ?? cleanupGraceMs)).toISOString() : undefined;
    task.status = "interrupted"; task.finishedAt = now.toISOString(); task.updatedAt = task.finishedAt; task.progress = { ...task.progress, updatedAt: task.updatedAt, workerStatus: pending ? "revoked" : "lost", summary: pending ? "Execution lease revoked; bounded worker cleanup is pending." : "Task interrupted; no live execution lease remains.", diagnostic: reason };
    if (task.execution.lease) { task.execution.lease.state = "revoked"; task.execution.lease.revokedAt = now.toISOString(); task.execution.lease.cleanupDeadlineAt = retryAfter ?? now.toISOString(); }
    this.finishAttempt(task, "interrupted");
    task.recovery = { reason, lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: executionId, actions, retryAvailable: !pending, ...(retryAfter ? { retryAfter } : {}), cleanupStatus: pending ? "pending" : "not_required", ...(!pending ? { operation: `/v1/tasks/${task.id}/retry` } : {}) };
    await this.persist(task, "task_interrupted", reason); await this.writeInterruptedResult(task);
  }
  private async watchdogTick(): Promise<void> { const now = Date.now(); for (const raw of await this.store.listTasks()) await this.withLock(raw.id, async () => { const task = await this.readTask(raw.id); if (!["running", "continuing"].includes(task.status)) return; const heartbeatAge = now - Date.parse(task.progress.lastHeartbeatAt ?? task.updatedAt); const live = this.liveWorker(task); if (!live) await this.interrupt(task, "worker_lost", ["retry", "cancel"]); else if (heartbeatAge > this.timing.staleHeartbeatMs) await this.interrupt(task, "stale_heartbeat", ["retry", "cancel"]); else if (task.progress.deadlineAt && now > Date.parse(task.progress.deadlineAt)) await this.interrupt(task, "execution_deadline_exceeded", ["retry", "cancel"]); }); }
  private liveWorker(task: ControlTaskRecord): ActiveWorker | null {
    const lease = task.execution.lease; const worker = this.active.get(task.id);
    if (!lease || lease.state !== "active" || !worker || worker.cancelled || worker.executionId !== lease.executionId || task.progress.executionId !== lease.executionId || !["running", "continuing"].includes(task.status)) return null;
    return worker;
  }
  private executionIsCurrent(task: ControlTaskRecord, executionId: string): boolean { return task.execution.lease?.state === "active" && task.execution.lease.executionId === executionId && task.progress.executionId === executionId; }
  private finishAttempt(task: ControlTaskRecord, outcome: "completed" | "failed" | "interrupted"): void { const attempt = task.execution.attempts.find((item) => item.executionId === task.progress.executionId); if (attempt) { attempt.outcome = outcome; attempt.finishedAt = task.finishedAt ?? new Date().toISOString(); } }
  private async advanceRecovery(task: ControlTaskRecord): Promise<void> {
    const recovery = task.recovery; if (task.status !== "interrupted" || !recovery || !["pending", "detached"].includes(recovery.cleanupStatus)) return;
    const executionId = recovery.originalExecutionId; const settled = Boolean(executionId && this.settledExecutions.has(executionId));
    if (recovery.cleanupStatus === "detached" && !settled) return;
    if (!settled && recovery.retryAfter && Date.now() < Date.parse(recovery.retryAfter)) return;
    recovery.cleanupStatus = settled ? "completed" : "detached"; recovery.retryAvailable = settled; delete recovery.retryAfter;
    if (settled) { recovery.operation = `/v1/tasks/${task.id}/retry`; recovery.actions = ["retry", "cancel"]; }
    else { delete recovery.operation; recovery.actions = ["cancel", "start_new_task", "restart_control_plane"]; }
    task.progress.workerStatus = settled ? "lost" : "revoked"; task.progress.summary = settled ? "Revoked worker completed cleanup; retry is available." : "Cleanup window expired without worker completion; in-place retry is blocked to prevent overlapping target mutations.";
    await this.persist(task, settled ? "worker_cleanup_completed" : "worker_cleanup_failed", executionId ?? undefined); await this.writeInterruptedResult(task);
  }
  private async writeInterruptedResult(task: ControlTaskRecord): Promise<void> {
    const executionId = task.progress.executionId ?? task.recovery?.originalExecutionId ?? "unknown";
    const artifacts = await readdir(task.artifactRoot, { recursive: true }).catch(() => [] as string[]);
    const spec = await this.store.readSpec(task.id); const criteria = object(object(spec).task).acceptanceCriteria;
    const incomplete = Array.isArray(criteria) ? criteria.map(String) : ["Execution did not reach a trusted terminal result."];
    await this.store.writePublishedResult(task.id, executionId, {
      schemaVersion: 1, taskId: task.id, status: "interrupted", lastCompletedPhase: task.recovery?.lastPhase ?? task.progress.phase,
      interruption: { reason: task.recovery?.reason, originalExecutionId: executionId, lastHeartbeatAt: task.progress.lastHeartbeatAt, deadlineAt: task.progress.deadlineAt },
      execution: { id: executionId, attempt: task.progress.attempt, operation: task.progress.operation },
      targetMutation: { status: "not_inferred", assertion: "Interrupted execution never implies that target mutations completed." },
      artifacts: { root: task.artifactRoot, created: artifacts.sort() }, validations: { incomplete }, recovery: task.recovery,
      safetyAssertions: { staleLeaseRevoked: task.execution.lease?.state !== "active", lateWorkerResultIgnored: true, attemptArtifactsIsolated: task.execution.attempts.filter((attempt) => attempt.artifactRoot === task.artifactRoot).length === 1, providerCallsInferred: false },
      nextAction: task.recovery?.retryAvailable ? task.recovery.operation : { poll: `/v1/tasks/${task.id}`, retryAfter: task.recovery?.retryAfter }
    });
  }
  private async ensureContinuationSnapshot(task: ControlTaskRecord): Promise<void> {
    if (task.continuation.state === "available") {
      const existing = await this.store.readContinuation(task.id).catch(() => null);
      if (existing && await this.validateContinuationSnapshot(task, existing)) return;
      task.continuation.state = "unrecoverable"; await this.store.saveTask(task); return;
    }
    let native: Record<string, unknown>; try { native = object(JSON.parse(await readFile(join(task.artifactRoot, "continuation-state.json"), "utf8"))); } catch { task.continuation.state = "unrecoverable"; await this.store.saveTask(task); return; }
    const context = await this.continuationContext(task);
    if (!context || !nativeMatchesContinuationContext(native, context.binding)) { task.continuation.state = "unrecoverable"; await this.store.saveTask(task); return; }
    task.continuation.sourceExecutionId = task.progress.executionId;
    const snapshot = { schemaVersion: 1, ...context.binding, authority: task.authority, decisionId: task.continuation.decisionId, executionIdentity: task.continuation.sourceExecutionId, taskSpec: context.spec, specPath: basename(task.specPath), runtime: object(context.spec.runtime), bindingHash: continuationBindingHash(context.binding, task.authority, context.spec), native };
    await this.store.saveContinuation(task.id, snapshot); task.continuation.state = "available"; await this.store.saveTask(task);
  }
  private async restoreContinuation(task: ControlTaskRecord): Promise<boolean> {
    const snapshot = await this.store.readContinuation(task.id).catch(() => null);
    if (!snapshot || !(await this.validateContinuationSnapshot(task, snapshot))) { task.continuation.state = "unrecoverable"; await this.store.saveTask(task); return false; }
    try { const path = join(task.artifactRoot, "continuation-state.json"); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(snapshot.native, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); task.continuation.state = "available"; await this.store.saveTask(task); return true; } catch { task.continuation.state = "unrecoverable"; await this.store.saveTask(task); return false; }
  }
  private async validateContinuationSnapshot(task: ControlTaskRecord, snapshot: Record<string, unknown>): Promise<boolean> {
    const context = await this.continuationContext(task); if (!context) return false;
    const sourceExecutionId = task.continuation.sourceExecutionId ?? (typeof snapshot.executionIdentity === "string" ? snapshot.executionIdentity : null);
    const binding = context.binding;
    const matches = snapshot.schemaVersion === 1 && snapshot.taskId === binding.taskId && snapshot.projectId === binding.projectId && snapshot.repository === binding.repository && snapshot.workingDirectory === binding.workingDirectory && snapshot.sourceBranch === binding.sourceBranch && snapshot.sourceSha === binding.sourceSha
      && snapshot.decisionId === task.continuation.decisionId && snapshot.executionIdentity === sourceExecutionId && JSON.stringify(snapshot.authority) === JSON.stringify(task.authority) && snapshot.bindingHash === continuationBindingHash(binding, task.authority, context.spec)
      && JSON.stringify(snapshot.taskSpec) === JSON.stringify(context.spec) && nativeMatchesContinuationContext(object(snapshot.native), binding);
    if (!matches) return false;
    task.continuation.sourceExecutionId = sourceExecutionId; await this.store.saveTask(task); return true;
  }
  private async continuationContext(task: ControlTaskRecord): Promise<{ spec: Record<string, unknown>; binding: ContinuationBinding } | null> {
    const spec = await this.store.readSpec(task.id); if (!spec || spec.taskId !== task.id) return null;
    const target = object(spec.target); const repository = typeof target.repository === "string" ? target.repository : null; const workingDirectory = typeof target.workingDirectory === "string" ? target.workingDirectory : null; const sourceSha = typeof target.expectedSha === "string" ? target.expectedSha : null;
    if (!repository || !workingDirectory || !sourceSha) return null;
    const inspection = await inspectProject(repository, workingDirectory).catch(() => null);
    if (!inspection?.repositoryRoot || !inspection.workingDirectory || !inspection.branch || inspection.detachedHead || inspection.repositoryRoot !== repository || inspection.workingDirectory !== workingDirectory || inspection.head !== sourceSha) return null;
    if (task.projectId) { const project = await this.store.getProject(task.projectId); if (!project || project.repository !== repository || project.workingDirectory !== workingDirectory) return null; }
    return { spec, binding: { taskId: task.id, projectId: task.projectId, repository, workingDirectory, sourceBranch: inspection.branch, sourceSha } };
  }
  private async acceptedSourceIsCurrent(task: ControlTaskRecord): Promise<boolean> {
    const spec = await this.store.readSpec(task.id); const target = object(object(spec).target); const repository = typeof target.repository === "string" ? target.repository : null; const workingDirectory = typeof target.workingDirectory === "string" ? target.workingDirectory : null; const expectedSha = typeof target.expectedSha === "string" ? target.expectedSha : null;
    const inspection = repository && workingDirectory ? await inspectProject(repository, workingDirectory).catch(() => null) : null;
    const project = task.projectId ? await this.store.getProject(task.projectId) : null;
    if (spec?.taskId === task.id && repository && workingDirectory && expectedSha && inspection?.repositoryRoot === repository && inspection.workingDirectory === workingDirectory && inspection.head === expectedSha && (!task.projectId || project?.repository === repository && project?.workingDirectory === workingDirectory)) return true;
    task.recovery = { reason: expectedSha ? "target_sha_changed" : "accepted_source_identity_missing", lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: task.progress.executionId, actions: ["cancel", "start_new_task"], retryAvailable: false, cleanupStatus: "completed", operation: "start_new_task", prerequisites: ["Submit a new TaskSpec against the intended current source."], newTaskRequired: true, previousArtifactsReusable: false, targetShaChanged: expectedSha ? true : null };
    await this.persist(task, "retry_blocked", task.recovery.reason); await this.writeInterruptedResult(task); return false;
  }
  private async markContinuationUnrecoverable(task: ControlTaskRecord): Promise<void> { if (task.status !== "interrupted") await this.interrupt(task, "continuation_state_unrecoverable", ["cancel", "start_new_task"]); task.continuation.state = "unrecoverable"; task.recovery = { reason: "continuation_state_unrecoverable", lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: task.progress.executionId, actions: ["cancel", "start_new_task"], retryAvailable: false, cleanupStatus: "completed", operation: "start_new_task", prerequisites: ["Submit a new TaskSpec; the persisted continuation identity cannot be trusted."], newTaskRequired: true, previousArtifactsReusable: false, targetShaChanged: null }; await this.persist(task, "continuation_unrecoverable"); await this.writeInterruptedResult(task); }
  private async persist(task: ControlTaskRecord, type: string, detail?: string): Promise<void> { const event = { at: new Date().toISOString(), type, ...(detail ? { detail } : {}) }; if (task.events.at(-1)?.type !== type || type !== "heartbeat") task.events.push(event); await this.store.saveTask(task); if (type !== "heartbeat") await this.store.appendEvent(task.id, { ...event, executionId: task.progress.executionId ?? undefined }); }
  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> { const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void; const next = new Promise<void>((done) => { release = done; }); const tail = previous.then(() => next); this.locks.set(id, tail); await previous; try { return await action(); } finally { release(); if (this.locks.get(id) === tail) this.locks.delete(id); } }
  private async readTask(id: string): Promise<ControlTaskRecord> { const task = await this.store.getTask(id); if (!task) throw new ControlPlaneError(404, "task_not_found", `Task not found: ${id}`, undefined, false, id); return normalizeTask(task); }
  private async requireProject(id: string): Promise<ProjectRecord> { const project = await this.store.getProject(id); if (!project) throw new ControlPlaneError(404, "project_not_found", `Project not found: ${id}`); return project; }

  private async assertAgreementProjectBinding(agreement: ExecutionAgreement, project: ProjectRecord | null, taskId: string): Promise<void> {
    const bound = agreement.context?.project;
    if (!bound) {
      if (!project) return;
      throw new ControlPlaneError(409, "execution_agreement_project_context_required", "A context-free Execution Agreement cannot authorize a registered-project task.", { agreementId: agreement.agreementId, projectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
    }
    if (!project) {
      throw new ControlPlaneError(409, "execution_agreement_project_mismatch", "The referenced Execution Agreement is bound to a different registered project.", { agreementId: agreement.agreementId, agreementProjectId: bound.projectId, taskProjectId: null, operation: "start_new_task", newTaskRequired: true }, false, taskId);
    }
    const current = await inspectProject(project.repository, project.workingDirectory).catch(() => null);
    const canonicalProjectMatches = current !== null && current.repositoryRoot !== null && current.workingDirectory !== null
      && project.id === bound.projectId
      && project.repository === current.repositoryRoot && project.workingDirectory === current.workingDirectory
      && bound.repository === current.repositoryRoot && bound.workingDirectory === current.workingDirectory;
    if (!canonicalProjectMatches) {
      throw new ControlPlaneError(409, "execution_agreement_project_mismatch", "The referenced Execution Agreement is not bound to the canonical registered project identity.", { agreementId: agreement.agreementId, agreementProjectId: bound.projectId, taskProjectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
    }
    if (!bound.source || current!.head !== bound.source.head || current!.branch !== bound.source.branch || current!.detachedHead !== bound.source.detachedHead) {
      throw new ControlPlaneError(409, "execution_agreement_source_stale", "The referenced Execution Agreement was negotiated for a different project source identity.", { agreementId: agreement.agreementId, projectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
    }
  }

  private async executionAgreementContext(project: ProjectRecord | null, publicationTarget: ExecutionAgreementContext["publicationTarget"]): Promise<ExecutionAgreementContext> {
    if (!project) return {
      project: null,
      policy: { sources: ["runforge-installation-policy"], hardBoundaries: agreementHardBoundaries(), runforgeMd: { present: false, path: null, authorityEscalationTrusted: false } },
      publicationTarget,
    };
    const inspection = await inspectProject(project.repository, project.workingDirectory);
    if (!inspection.repositoryRoot || !inspection.workingDirectory) throw new ControlPlaneError(409, "registered_project_unavailable", "The registered project no longer resolves to a canonical repository and working directory.");
    const runforgeCandidates = [...new Set([join(project.repository, project.workingDirectory === "." ? "" : project.workingDirectory, "RUNFORGE.md"), join(project.repository, "RUNFORGE.md")])];
    const runforgePath = (await Promise.all(runforgeCandidates.map(async (candidate) => await access(candidate).then(() => candidate, () => null)))).find((candidate): candidate is string => candidate !== null) ?? null;
    const present = runforgePath !== null;
    const protectedBranches = [...new Set([inspection.defaultBranch, "main", "master", "develop", "source"].filter((item): item is string => Boolean(item)))].sort();
    return {
      project: {
        projectId: project.id, repository: inspection.repositoryRoot, workingDirectory: inspection.workingDirectory,
        source: { head: inspection.head, branch: inspection.branch, detachedHead: inspection.detachedHead },
        defaultBranch: inspection.defaultBranch, protectedBranches,
      },
      policy: {
        sources: ["runforge-installation-policy", ...(present ? ["project/RUNFORGE.md (defaults only; no authority escalation)"] : [])],
        hardBoundaries: agreementHardBoundaries(),
        runforgeMd: { present, path: runforgePath ? relative(project.repository, runforgePath) || "RUNFORGE.md" : null, authorityEscalationTrusted: false },
      },
      publicationTarget,
    };
  }
}

function progress(now: string, timeoutMs = executionTimeoutMs): ControlTaskRecord["progress"] { return { phase: "queued", operation: "execution", startedAt: null, updatedAt: now, lastHeartbeatAt: null, executionId: null, attempt: 0, workerStatus: "idle", timeoutMs, deadlineAt: null, summary: "Queued for execution.", diagnostic: null }; }
function runforgeOwns(agreement: ExecutionAgreement, phaseId: "localBranch" | "localCommit"): boolean { const phase = agreement.phases.find((item) => item.phaseId === phaseId); return phase?.requested === true && phase.responsibleParty === "runforge"; }
function implementationParty(agreement: ExecutionAgreement): "external_session" | "external_system" | null { const phase = agreement.phases.find((item) => item.phaseId === "implementation"); return phase?.requested === true && (phase.responsibleParty === "external_session" || phase.responsibleParty === "external_system") ? phase.responsibleParty : null; }
function normalizeTask(task: ControlTaskRecord): ControlTaskRecord {
  task.progress ??= progress(task.updatedAt); task.progress.attempt ??= 1;
  task.execution ??= { attempt: task.progress.attempt, lease: task.progress.executionId ? { executionId: task.progress.executionId, attempt: task.progress.attempt, operation: task.progress.operation as "execution" | "continuation", state: ["running", "continuing"].includes(task.status) ? "active" : "finished", startedAt: task.progress.startedAt ?? task.updatedAt, revokedAt: null, cleanupDeadlineAt: null } : null, attempts: [], lastRetry: null };
  task.execution.attempts ??= []; task.execution.lastRetry ??= null;
  if (task.recovery) { const retryAvailable = task.recovery.retryAvailable ?? Boolean(task.recovery.operation); const cleanupPending = ["pending", "detached"].includes(task.recovery.cleanupStatus); task.recovery = { ...task.recovery, originalExecutionId: task.recovery.originalExecutionId ?? task.progress.executionId, retryAvailable, cleanupStatus: task.recovery.cleanupStatus ?? "not_required", ...(!task.recovery.operation && !cleanupPending ? { operation: retryAvailable ? `/v1/tasks/${task.id}/retry` : "start_new_task" } : {}), prerequisites: task.recovery.prerequisites ?? (retryAvailable ? ["Previous worker cleanup must be complete.", "Target SHA must still match the accepted TaskSpec."] : cleanupPending ? ["Poll until bounded worker cleanup completes."] : ["Correct the reported failure.", "Submit a current TaskSpec v2."]), newTaskRequired: task.recovery.newTaskRequired ?? (!retryAvailable && !cleanupPending), previousArtifactsReusable: task.recovery.previousArtifactsReusable ?? true, targetShaChanged: task.recovery.targetShaChanged ?? null }; }
  task.recovery ??= null; task.continuation ??= { schemaVersion: 1, state: "none", decisionId: null, executionId: null, sourceExecutionId: null }; task.continuation.sourceExecutionId ??= null; task.progress.agreement ??= projectAgreementLifecycle(task); return task;
}

const publicDiagnosticBytes = 8_192;
const publicStringBytes = 65_536;

export function projectAgreementLifecycle(task: Pick<ControlTaskRecord, "executionAgreement" | "ownerGate" | "publicationGate" | "progress">, result?: Record<string, unknown>): AgreementLifecycleProjection | undefined {
  const agreement = task.executionAgreement;
  if (!agreement) return undefined;
  const workflow = object(result?.workflow);
  const directSummary = object(result?.agreement); const workflowSummary = object(workflow.agreement); const hasResultSummary = Object.keys(directSummary).length > 0 || Object.keys(workflowSummary).length > 0;
  const summary = Object.keys(directSummary).length ? directSummary : workflowSummary;
  const next = object(Object.keys(object(result?.next)).length ? result?.next : workflow.next);
  const completed = phaseIds(summary.runforgeCompletedPhases ?? task.progress.agreement?.runforgeCompletedPhases);
  const delegated = delegatedPhases(summary.delegatedPhases ?? task.progress.agreement?.delegatedPhases, agreement);
  const awaiting = awaitingPhases(summary.awaitingPhases ?? task.progress.agreement?.awaitingPhases, agreement, completed);
  const resultAgreementCompleted = summary.status === "completed" || ["completed", "workflow_completed"].includes(String(result?.status));
  const current = hasResultSummary ? awaiting[0] ?? (resultAgreementCompleted ? undefined : agreement.phases.find((phase) => phase.requested && !completed.includes(phase.phaseId))) : agreement.phases.find((phase) => phase.requested && !completed.includes(phase.phaseId));
  const nextParty = executionParty(next.party) ?? (current?.responsibleParty === "nobody" ? null : current?.responsibleParty ?? null);
  const legacyNext = object(result?.nextAction);
  const currentReason = current ? agreement.phases.find((phase) => phase.phaseId === current.phaseId)?.reason ?? null : null;
  return {
    schemaVersion: agreement.schemaVersion, agreementId: agreement.agreementId, profile: agreement.profile,
    currentPhase: current?.phaseId ?? null, responsibleParty: current?.responsibleParty ?? null,
    runforgeCompletedPhases: completed, delegatedPhases: delegated, awaitingPhases: awaiting,
    nextParty, nextAction: textValue(next.exactAction) ?? textValue(legacyNext.recommendation) ?? currentReason,
    conflicts: agreement.conflicts.map((conflict) => ({ ...conflict })), ownerGate: { ...task.ownerGate }, publicationGate: { ...task.publicationGate },
  };
}

function settleAcceptedAgreement(result: Record<string, unknown>, agreement: ExecutionAgreement): Record<string, unknown> {
  const settled = structuredClone(result);
  const workflow = object(settled.workflow);
  const direct = object(settled.agreement); const nested = object(workflow.agreement);
  const source = Object.keys(direct).length ? direct : nested;
  if (!Object.keys(source).length) return settled;
  const completed = new Set(phaseIds(source.runforgeCompletedPhases));
  const sourceAwaiting = Array.isArray(source.awaitingPhases)
    ? new Map(source.awaitingPhases.flatMap((item) => { const phase = object(item); return typeof phase.phaseId === "string" ? [[phase.phaseId, phase] as const] : []; }))
    : null;
  const requested = agreement.phases.filter((phase) => phase.requested);
  const awaiting = agreement.handoffs
    .filter((phase) => !sourceAwaiting || sourceAwaiting.has(phase.phaseId))
    .map(({ phaseId, responsibleParty, prerequisites }) => ({ phaseId, responsibleParty, prerequisites: mergePrerequisites(prerequisites, sourceAwaiting?.get(phaseId)?.prerequisites) }));
  const summary = {
    ...source,
    agreementId: agreement.agreementId,
    profile: agreement.profile,
    requestedProfile: agreement.profile,
    effectiveProfile: agreement.profile,
    phaseOwnership: requested.map(({ phaseId, responsibleParty }) => ({ phaseId, responsibleParty })),
    runforgeCompletedPhases: requested.filter((phase) => phase.responsibleParty === "runforge" && completed.has(phase.phaseId)).map((phase) => phase.phaseId),
    delegatedPhases: agreement.handoffs.map(({ phaseId, responsibleParty }) => ({ phaseId, responsibleParty })),
    awaitingPhases: awaiting,
  };
  if (Object.keys(direct).length) settled.agreement = summary;
  else settled.workflow = { ...workflow, agreement: summary };
  const current = awaiting[0];
  if (current) {
    const gates = current.prerequisites.map((name) => ({ name, status: "pending", evidence: [] }));
    if (Object.keys(direct).length && Object.keys(object(settled.next)).length) settled.next = { ...object(settled.next), gates };
    if (!Object.keys(direct).length && Object.keys(object(workflow.next)).length) settled.workflow = { ...object(settled.workflow), next: { ...object(workflow.next), gates } };
  }
  return settled;
}

export function boundPublicResult(result: Record<string, unknown>): { result: Record<string, unknown>; truncatedFields: string[] } {
  const truncatedFields: string[] = [];
  const visit = (value: unknown, path: string[]): unknown => {
    if (typeof value === "string") {
      const key = path.at(-1) ?? ""; const limit = key === "stdout" || key === "stderr" ? publicDiagnosticBytes : publicStringBytes;
      if (Buffer.byteLength(value) <= limit) return redactPublicText(value);
      truncatedFields.push(path.join("."));
      return redactPublicText(`${Buffer.from(value).subarray(0, limit).toString("utf8")}\n[TRUNCATED: full output remains in the referenced artifact]`);
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, String(index)]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
    return value;
  };
  return { result: visit(result, []) as Record<string, unknown>, truncatedFields };
}

export function redactPublicValue<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactPublicText(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return visit(value) as T;
}

function redactPublicText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, "$1[REDACTED]")
    .replace(/(?:\/[A-Za-z0-9_.@-]+){2,}/g, (path) => path.startsWith("/v1/") || path.startsWith("/schemas/") || path.startsWith("/.well-known/") ? path : "[internal path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`,;:]+\\)*[^\\\s"'`,;:]+/g, "[internal path]");
}

function phaseIds(value: unknown): AgreementLifecycleProjection["runforgeCompletedPhases"] { return Array.isArray(value) ? value.filter((item): item is AgreementLifecycleProjection["runforgeCompletedPhases"][number] => typeof item === "string") : []; }
function delegatedPhases(value: unknown, agreement: ExecutionAgreement): AgreementLifecycleProjection["delegatedPhases"] { if (!Array.isArray(value)) return agreement.handoffs.map(({ phaseId, responsibleParty }) => ({ phaseId, responsibleParty })); return value.flatMap((item) => { const phase = object(item); const party = executionParty(phase.responsibleParty); return typeof phase.phaseId === "string" && party && party !== "runforge" ? [{ phaseId: phase.phaseId, responsibleParty: party }] as AgreementLifecycleProjection["delegatedPhases"] : []; }); }
function awaitingPhases(value: unknown, agreement: ExecutionAgreement, completed: AgreementLifecycleProjection["runforgeCompletedPhases"]): AgreementLifecycleProjection["awaitingPhases"] { if (!Array.isArray(value)) return agreement.handoffs.filter((phase) => !completed.includes(phase.phaseId)).map(({ phaseId, responsibleParty, prerequisites }) => ({ phaseId, responsibleParty, prerequisites: [...prerequisites] })); return value.flatMap((item) => { const phase = object(item); const party = executionParty(phase.responsibleParty); if (typeof phase.phaseId !== "string" || !party || party === "runforge") return []; const accepted = agreement.phases.find((item) => item.phaseId === phase.phaseId); return [{ phaseId: phase.phaseId, responsibleParty: party, prerequisites: mergePrerequisites(accepted?.prerequisites ?? [], phase.prerequisites) }] as AgreementLifecycleProjection["awaitingPhases"]; }); }
function mergePrerequisites(accepted: readonly string[], projected: unknown): string[] { return [...new Set([...accepted, ...(Array.isArray(projected) ? projected.map(String) : [])])]; }
function executionParty(value: unknown): AgreementLifecycleProjection["nextParty"] { return ["runforge", "external_session", "owner", "external_system"].includes(String(value)) ? value as AgreementLifecycleProjection["nextParty"] : null; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} is required.`); return value.trim(); }
function continuationBindingHash(binding: ContinuationBinding, authority: ControlAuthority, taskSpec: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify({ binding, authority, taskSpec })).digest("hex"); }
function nativeMatchesContinuationContext(native: Record<string, unknown>, binding: ContinuationBinding): boolean {
  const sourceBefore = object(native.sourceBefore);
  return native.schemaVersion === 1 && native.taskId === binding.taskId && native.repo === binding.repository && native.workingDirectory === binding.workingDirectory && native.sourceBranch === binding.sourceBranch && sourceBefore.path === binding.repository && sourceBefore.head === binding.sourceSha;
}
function decisionRecord(decisionId: string, kind: "owner" | "publication", decision: string, response: Record<string, unknown>): DecisionRecord { return { decisionId, kind, decision, response, createdAt: new Date().toISOString() }; }
function safeMessage(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return redactPublicText(message).slice(0, 500); }
function preflightError(code: string, message: string, spec: Awaited<ReturnType<typeof loadTaskSpecV2>>, authority: ControlAuthority): ControlPlaneError {
  return new ControlPlaneError(403, code, message, {
    requestedMode: spec.execution.mode,
    requestedRuntime: spec.runtime.preference,
    authorityFailures: [code],
    authorityChecks: {
      implementation: authority.implementation,
      providerCalls: authority.providerCalls === true,
      network: authority.network === true,
      localBranch: authority.localBranch,
      localCommit: authority.localCommit
    },
    operation: "start_new_task",
    newTaskRequired: true
  }, false, spec.taskId);
}
function continuationError(task: ControlTaskRecord, error: unknown): ControlPlaneError { return new ControlPlaneError(409, "continuation_state_unavailable", "Owner decision could not be safely bound to continuation state.", { reason: safeMessage(error), recoveryActions: ["retry", "cancel"] }, false, task.id); }
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> { if (signal.aborted) throw new Error("cancelled"); return new Promise<T>((resolve, reject) => { const cancel = () => reject(new Error("cancelled")); signal.addEventListener("abort", cancel, { once: true }); work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel)); }); }
