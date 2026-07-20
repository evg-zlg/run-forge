import { createHash, randomUUID } from "node:crypto"; import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"; import { basename, join } from "node:path";
import { buildDoctorReport } from "../product/doctor.js"; import { runTaskSpecFile } from "../product/task-spec-runner.js";
import { loadTaskSpecV2 } from "../product/task-spec-v2.js"; import { implementationExecutorContract, runtimeCompatibleWithImplementationExecutor, taskRuntimeIds } from "../product/task-spec-contract.js";
import { continueExternalExecution, recordOwnerDecision } from "../run/external-execution.js";
import { ControlPlaneError, type CampaignPlan, type CampaignPlanNode, type CampaignRecord, type CampaignSpec, type ControlAuthority, type ControlTaskRecord, type DecisionRecord, type ProjectRecord } from "./contracts.js";
import { ControlPlaneStore } from "./state.js";
import { discoverImplementationExecutors, selectImplementationExecutor } from "../implementation/executor.js";
import type { ExecutionAgreement } from "../product/execution-agreement.js";
import { inspectProject } from "../product/project-inspection.js";
import { assertAgreementAccepted, assertAgreementMatchesTask, negotiateControlPlaneAgreement, negotiateTaskAgreement, technicalCapabilitiesForExecutor, type ExecutionAgreementNegotiationRequest } from "./execution-agreements.js";
import { boundPublicResult, projectAgreementLifecycle, publicResultLimits, redactPublicValue, settleAcceptedAgreement } from "./manager-results.js";
import { detectCycle, planCampaignFromGoal, validateCampaignPlan } from "../run/task-run-planner.js";
import { assertAgreementProjectBinding, buildExecutionAgreementContext } from "./manager-project-context.js";
import { listDurableCheckpoints } from "../implementation/durable-checkpoint.js"; import { resumeDurableCheckpoint } from "../implementation/checkpoint-resume.js";
import { acceptCompletedResult, discardCompletedResult } from "./completed-result-acceptance.js";
import { exposeCheckpointRepairDigests, startCheckpointRepair, type CheckpointRepairRequest } from "./checkpoint-repair.js";
import { buildTimeoutContract } from "./timeout-contract.js"; import { acceptValidationCapabilities } from "./validation-negotiation.js";
import { openRouterReadiness, providerForExecutor, publicImplementationExecutors } from "./provider-routing-projection.js";
export { boundPublicResult, projectAgreementLifecycle, redactPublicValue } from "./manager-results.js";
const executionTimeoutMs = implementationExecutorContract.maxLimits.timeoutMs, heartbeatIntervalMs = 1_000, staleHeartbeatMs = 15_000, cleanupGraceMs = 2_000;
type ActiveWorker = { executionId: string; operation: "execution" | "continuation"; cancelled: boolean; controller: AbortController }; type ContinuationBinding = { taskId: string; projectId: string | null; repository: string; workingDirectory: string; sourceBranch: string; sourceSha: string };
export class ControlPlaneManager {
  private readonly active = new Map<string, ActiveWorker>();
  private readonly settledExecutions = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly journalHeartbeats = new Map<string, number>();
  private readonly activeCampaignLoops = new Map<string, Promise<void>>();
  private watchdog: NodeJS.Timeout | null = null;
  constructor(
    public readonly store: ControlPlaneStore,
    private readonly operations: { runTaskSpec: typeof runTaskSpecFile; recordOwnerDecision: typeof recordOwnerDecision; continueExecution: typeof continueExternalExecution } = { runTaskSpec: runTaskSpecFile, recordOwnerDecision, continueExecution: continueExternalExecution },
    private readonly timing: { heartbeatIntervalMs: number; staleHeartbeatMs: number; executionTimeoutMs: number; cleanupGraceMs?: number } = { heartbeatIntervalMs, staleHeartbeatMs, executionTimeoutMs, cleanupGraceMs }
  ) {}
  async initialize(): Promise<void> { await this.store.initialize(); this.watchdog ??= setInterval(() => void this.watchdogTick(), Math.min(this.timing.staleHeartbeatMs, 5_000)); this.watchdog.unref(); await this.resumeCampaignsOnInitialize(); }
  async createCampaign(spec: CampaignSpec): Promise<CampaignRecord> {
    if (!spec.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a campaign.");
    if (spec.providerRouting.provider === "openrouter" && spec.providerRouting.fallbackPolicy && spec.providerRouting.fallbackPolicy !== "none") throw new ControlPlaneError(422, "invalid_campaign", "OpenRouter campaigns must set fallbackPolicy='none'.");
    const now = new Date().toISOString();
    const id = `cmp_v1_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const record: CampaignRecord = { schemaVersion: 1, id, status: "planning", spec, plan: null, plannerEvidence: null, children: {}, usage: { tokens: 0, costUsd: 0, tasks: 0 }, checkpoints: [], failures: [], result: null, createdAt: now, updatedAt: now };
    await this.saveCampaign(record);
    const plan = await this.planCampaign(record);
    validateCampaignPlan(plan, { maxTasks: spec.limits.maxTasks, maxTokens: spec.limits.maxTokens, maxCostUsd: spec.limits.maxCostUsd }, spec.authority, { requireOpenRouter: spec.providerRouting.provider === "openrouter" });
    const cycle = detectCycle(plan.nodes.map((item) => ({ id: item.id, dependsOn: item.dependsOn })));
    if (cycle.length) throw new ControlPlaneError(422, "campaign_cycle_detected", `Campaign plan contains a cycle: ${cycle.join(" -> ")}`);
    record.plan = plan;
    record.plannerEvidence = { planner: "internal-campaign-planner-v1", createdAt: now, nodeCount: plan.nodes.length };
    record.children = Object.fromEntries(plan.nodes.map((node) => [node.id, { nodeId: node.id, dependsOn: node.dependsOn, taskId: null, status: "pending", startedAt: null, finishedAt: null, error: null, accounted: false }]));
    record.status = "queued";
    record.updatedAt = new Date().toISOString();
    await this.saveCampaign(record);
    this.ensureCampaignLoop(record.id);
    return record;
  }
  async listCampaigns(): Promise<Array<Pick<CampaignRecord, "id" | "status" | "createdAt" | "updatedAt" | "usage">>> { return (await this.readCampaigns()).map((item) => ({ id: item.id, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, usage: item.usage })); }
  async getCampaign(id: string): Promise<CampaignRecord> { const campaign = await this.readCampaign(id); if (!campaign) throw new ControlPlaneError(404, "campaign_not_found", `Campaign not found: ${id}`); return campaign; }
  async getCampaignResult(id: string): Promise<Record<string, unknown>> {
    const campaign = await this.getCampaign(id);
    if (!["completed", "failed", "on_hold"].includes(campaign.status) || !campaign.result) throw new ControlPlaneError(404, "campaign_result_not_ready", `Campaign result is not ready: ${id}`);
    return campaign.result;
  }
  private async resumeCampaignsOnInitialize(): Promise<void> { for (const campaign of await this.readCampaigns()) if (["planning", "queued", "running"].includes(campaign.status)) this.ensureCampaignLoop(campaign.id); }
  private ensureCampaignLoop(id: string): void {
    if (this.activeCampaignLoops.has(id)) return;
    const loop = this.runCampaign(id).finally(() => this.activeCampaignLoops.delete(id));
    this.activeCampaignLoops.set(id, loop);
  }
  private async runCampaign(id: string): Promise<void> {
    while (true) {
      const campaign = await this.readCampaign(id);
      if (!campaign || !campaign.plan || ["completed", "failed", "on_hold"].includes(campaign.status)) return;
      campaign.status = "running";
      let progressed = false;
      for (const child of Object.values(campaign.children)) {
        if (!child.taskId || !["queued", "running"].includes(child.status)) continue;
        const task = await this.getTask(child.taskId).catch(() => null);
        if (!task) continue;
        if (task.status === "completed") { child.status = "completed"; child.finishedAt = new Date().toISOString(); progressed = true; if (!child.accounted) { const result = await this.getResult(child.taskId).catch(() => ({})); const usage = aggregateUsageFromValue(result); campaign.usage.tokens += usage.tokens; campaign.usage.costUsd += usage.costUsd; child.evidence = boundPublicResult(result).result; child.accounted = true; campaign.usage.tasks += 1; } }
        else if (["failed", "interrupted"].includes(task.status)) { child.status = "failed"; child.finishedAt = new Date().toISOString(); child.error = task.error ?? "child_failed"; campaign.status = "failed"; campaign.failures.push({ at: child.finishedAt, nodeId: child.nodeId, taskId: child.taskId, reason: child.error }); }
        else child.status = "running";
      }
      if (campaign.status === "failed") { campaign.result = this.reconcileCampaignResult(campaign); campaign.updatedAt = new Date().toISOString(); await this.saveCampaign(campaign); return; }
      if (campaign.spec.limits.maxCostUsd !== undefined && campaign.usage.costUsd > campaign.spec.limits.maxCostUsd || campaign.usage.tokens > campaign.spec.limits.maxTokens) { campaign.status = "failed"; campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_budget_exceeded" }); campaign.result = this.reconcileCampaignResult(campaign); campaign.updatedAt = new Date().toISOString(); await this.saveCampaign(campaign); return; }
      const activeChildren = Object.values(campaign.children).filter((item) => ["queued", "running"].includes(item.status)).length;
      const slots = Math.max(0, campaign.spec.limits.maxConcurrency - activeChildren);
      if (slots > 0) {
        const ready = campaign.plan.nodes.filter((node) => {
          const child = campaign.children[node.id];
          if (!child || child.status !== "pending") return false;
          return node.dependsOn.every((dep) => campaign.children[dep]?.status === "completed");
        }).slice(0, slots);
        for (const node of ready) {
          const child = campaign.children[node.id]!;
          const task = await this.createTask({ ...(campaign.spec.target.projectId ? { projectId: campaign.spec.target.projectId } : {}), taskSpec: node.taskSpec, authority: campaign.spec.authority, publicationRequested: "none" });
          child.taskId = task.id; child.status = task.status === "queued" ? "queued" : "running"; child.startedAt = new Date().toISOString();
          progressed = true;
        }
      }
      const allDone = Object.values(campaign.children).every((child) => child.status === "completed");
      if (allDone) { campaign.status = "completed"; campaign.result = this.reconcileCampaignResult(campaign); campaign.updatedAt = new Date().toISOString(); await this.saveCampaign(campaign); return; }
      campaign.updatedAt = new Date().toISOString();
      await this.saveCampaign(campaign);
      if (!progressed && Object.values(campaign.children).every((child) => child.status === "pending")) { campaign.status = "on_hold"; campaign.failures.push({ at: new Date().toISOString(), reason: "campaign_no_schedulable_children" }); campaign.result = this.reconcileCampaignResult(campaign); campaign.updatedAt = new Date().toISOString(); await this.saveCampaign(campaign); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  private async planCampaign(record: CampaignRecord): Promise<CampaignPlan> { return planCampaignFromGoal(record.id, record.spec); }
  close(): void { if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null; for (const worker of this.active.values()) worker.controller.abort(); this.active.clear(); }
  async inspectProject(input: { path: string; workingDirectory: string; register: boolean; runtime?: "local" | "docker"; dependencyPreparation?: "required" | "if-needed" | "disabled" | "reuse-existing" }): Promise<Record<string, unknown>> {
    const report = await buildDoctorReport({ repo: input.path, workingDirectory: input.workingDirectory, runtime: input.runtime, dependencyPreparation: input.dependencyPreparation, publication: "none" });
    let project: ProjectRecord | null = null;
    if (input.register && report.targetRepository?.repositoryRoot && report.targetRepository.workingDirectory) {
      const now = new Date().toISOString(); const repository = await realpath(report.targetRepository.repositoryRoot);
      const existing = (await this.store.listProjects()).find((item) => item.repository === repository && item.workingDirectory === report.targetRepository!.workingDirectory);
      project = { id: this.store.projectId(repository, report.targetRepository.workingDirectory), repository, workingDirectory: report.targetRepository.workingDirectory, createdAt: existing?.createdAt ?? now, updatedAt: now }; await this.store.saveProject(project);
    }
    return { project, readiness: { ...report, checks: report.checks.map((item) => item.id === "implementation_executor" && item.status !== "passed" ? { ...item, summary: "Implementation executor or its existing credential mechanism is not ready; no credential data is exposed." } : item), implementationExecutors: report.implementationExecutors.map((item) => ({ id: item.id, provider: item.id === "openrouter-coding-agent" ? "openrouter" : "local", status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime, providerRequirements: item.providerRequirements, networkRequirements: item.networkRequirements, maxLimits: item.maxLimits, model: item.model, credentialReady: item.status === "ready", limitations: item.status === "ready" ? [] : ["Implementation executor or its existing credential mechanism is not ready; no credential data is exposed."] })) } };
  }
  async negotiateAgreement(input: ExecutionAgreementNegotiationRequest): Promise<ExecutionAgreement> {
    const project = input.projectId ? await this.requireProject(input.projectId) : null;
    const [executors, context] = await Promise.all([discoverImplementationExecutors(), buildExecutionAgreementContext({ project, publicationTarget: input.publicationTarget ?? { kind: "none" } })]);
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
    if (project) raw.target = { ...object(raw.target), repository: project.repository, workingDirectory: project.workingDirectory }; if (!raw.target) throw new ControlPlaneError(422, "project_required", "Provide projectId or taskSpec.target.");
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
    const automaticContext = project ? await buildExecutionAgreementContext({ project, publicationTarget: { kind: "none" } }) : undefined;
    const preflightAgreement = negotiateTaskAgreement(normalized, input.authority, automaticContext);
    const executionAgreement = input.agreementId ? await this.getAgreement(input.agreementId) : preflightAgreement;
    await assertAgreementProjectBinding({ agreement: executionAgreement, project, taskId });
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
    const validationNegotiation = acceptValidationCapabilities(normalized, executionAgreement, taskId);
    await this.store.saveAgreement(executionAgreement);
    const selected = implementation && !delegatedImplementation ? await selectImplementationExecutor(normalized) : null;
    const requestedProvider = normalized.providerRouting.provider;
    const selectedProvider = providerForExecutor(selected?.selected);
    // OpenRouter is an explicit route: a ready local credential must never satisfy it,
    // and there is deliberately no implicit local fallback.
    const openRouterMismatch = requestedProvider === "openrouter" && selectedProvider !== "openrouter";
    if (selected && (!selected.selected || openRouterMismatch)) throw new ControlPlaneError(503, requestedProvider === "openrouter" ? "openrouter_executor_unavailable" : "implementation_executor_unavailable", requestedProvider === "openrouter" ? "The requested OpenRouter coding agent is unavailable; no local fallback was selected." : selected.reason, { requestedMode: normalized.execution.mode, requestedProvider, effectiveProvider: selectedProvider, availableExecutors: selected.rejected.map((item) => item.id), rejectedAlternatives: selected.rejected, authorityFailures: [], noLocalFallback: requestedProvider === "openrouter", operation: "start_new_task", newTaskRequired: true }, true, taskId);
    const effectiveTimeoutMs = Math.min(normalized.execution.timeoutMs, this.timing.executionTimeoutMs, implementationExecutorContract.maxLimits.timeoutMs);
    const now = new Date().toISOString(); const task: ControlTaskRecord = {
      id: taskId, projectId: project?.id ?? null, status: "queued", specPath, artifactRoot, executionAgreement, validationNegotiation, authority: input.authority, publicationRequested,
      publicationGate: publicationRequested === "draft-pr" ? { required: true, status: "blocked_until_implementation_completes", reason: "Remote publication is a separate decision." } : { required: false, status: "not_requested" }, ownerGate: { required: false, status: "not_required" },
      timeout: buildTimeoutContract(normalized.execution.timeoutMs, effectiveTimeoutMs, this.timing.executionTimeoutMs, implementationExecutorContract.maxLimits.timeoutMs, now),
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, error: null, decisions: [], events: [], progress: progress(now, effectiveTimeoutMs), recovery: null,
      execution: { attempt: 0, lease: null, attempts: [], lastRetry: null }, continuation: { schemaVersion: 1, state: "none", decisionId: null, executionId: null, sourceExecutionId: null },
      selection: { requestedMode: normalized.execution.mode, normalizedMode: normalized.execution.mode, selectedExecutor: delegatedImplementation ? "agreement-handoff" : selected?.selected?.id ?? (normalized.execution.mode === "validation" ? "validation-lane" : "inspection-lane"), selectedRuntime: delegatedImplementation ? null : normalized.runtime.preference, selectionReason: delegatedImplementation ? `The effective Execution Agreement delegates implementation to ${delegatedImplementation}; RunForge will perform agreement/discovery work and settle a handoff without selecting a coding agent.` : selected?.reason ?? `Explicit ${normalized.execution.mode} mode uses its dedicated lane.`, rejectedAlternatives: selected?.rejected ?? [], authorityChecks: { inspect: input.authority.inspect, implementation: Boolean(delegatedImplementation) || !implementation || input.authority.implementation, providerCalls: Boolean(delegatedImplementation) || !normalized.authority.allowProviderCalls || input.authority.providerCalls === true, network: Boolean(delegatedImplementation) || !normalized.authority.allowNetwork || input.authority.network === true, localBranch: !runforgeOwns(executionAgreement, "localBranch") || input.authority.localBranch, localCommit: !runforgeOwns(executionAgreement, "localCommit") || input.authority.localCommit, publicationForbidden: normalized.git.publication === "none" }, providerDecision: delegatedImplementation ? "not_requested" : normalized.authority.allowProviderCalls ? "allowed" : "not_requested", networkDecision: delegatedImplementation ? "not_requested" : normalized.runtime.externalNetwork === "allowed" ? "allowed" : "denied", provider: delegatedImplementation ? null : requestedProvider === "openrouter" ? "openrouter" : selected?.selected?.providerCalls ? "configured-local-credential" : null, model: selected?.selected?.model ?? null, requestedProvider: delegatedImplementation ? null : requestedProvider, effectiveProvider: delegatedImplementation ? null : implementation ? selectedProvider : null, phaseModels: { ...normalized.providerRouting.models }, fallbackPolicy: normalized.providerRouting.fallbackPolicy, noLocalFallback: requestedProvider === "openrouter", budgets: { maxCalls: normalized.providerRouting.maxCalls, tokenBudget: normalized.providerRouting.tokenBudget, ...(normalized.providerRouting.costBudgetUsd === undefined ? {} : { costBudgetUsd: normalized.providerRouting.costBudgetUsd }), timeoutMs: normalized.providerRouting.timeoutMs, maxAttempts: normalized.providerRouting.retry.maxAttempts } }
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
  async getResult(id: string): Promise<Record<string, unknown>> { const task = await this.getTask(id); let published = await this.store.readPublishedResult(id); if (!published && task.status === "interrupted") { await this.writeInterruptedResult(task); published = await this.store.readPublishedResult(id); } if (!published || published.executionId !== task.progress.executionId) throw new ControlPlaneError(404, "result_not_ready", `Result is not available for active execution ${task.progress.executionId ?? "pending"}.`, undefined, true, id); const repairAware = await exposeCheckpointRepairDigests({ task, result: published.result, store: this.store }); const bounded = boundPublicResult(repairAware); const agreement = projectAgreementLifecycle(task, published.result); return { ...bounded.result, ...(task.validationNegotiation ? { validationNegotiation: task.validationNegotiation } : {}), ...(task.recovery ? { recovery: task.recovery } : {}), controlPlane: { status: task.status, progress: { ...task.progress, agreement }, agreement, ...(task.executionAgreement ? { executionAgreement: task.executionAgreement } : {}), ...(task.validationNegotiation ? { validationNegotiation: task.validationNegotiation } : {}), recovery: task.recovery, ownerGate: task.ownerGate, publicationGate: task.publicationGate, authority: task.authority, ...(bounded.truncatedFields.length ? { responseBounds: { truncated: true, ...publicResultLimits, truncatedFields: bounded.truncatedFields } } : {}) } }; }
  async acceptCompletedResult(id: string, input: { decisionId: string; checkpointId: string; delivery: "patch" | "local_commit" }): Promise<Record<string, unknown>> { return this.withLock(id, async () => { const task = await this.readTask(id); return acceptCompletedResult({ task, request: input, store: this.store, persist: (type, detail) => this.persist(task, type, detail) }); }); }
  async resumeCheckpoint(id: string, checkpointId: string, input: import("./contracts.js").CheckpointResumeRequest): Promise<Record<string, unknown>> { const task = await this.readTask(id), taskSpec = await this.store.readSpec(id); if (!taskSpec) throw new ControlPlaneError(409, "wrong_identity", "Persisted task identity is unavailable.", undefined, false, id); return resumeDurableCheckpoint({ task, taskSpec, checkpointId, request: input }); }
  async discardCompletedResult(id: string, input: { decisionId: string; checkpointId: string; confirmation: "discard_result" }): Promise<Record<string, unknown>> { return this.withLock(id, async () => { const task = await this.readTask(id); return discardCompletedResult({ task, request: input, store: this.store, persist: (type, detail) => this.persist(task, type, detail) }); }); }
  async repairFromCheckpoint(id: string, request: CheckpointRepairRequest): Promise<Record<string, unknown>> { return this.withLock(id, async () => { const task = await this.readTask(id); return startCheckpointRepair({ task, request, store: this.store, acceptedSourceIsCurrent: () => this.acceptedSourceIsCurrent(task), beginAttempt: (source) => this.beginAttempt(task, "execution", source), persist: (type, detail) => this.persist(task, type, detail) }); }); }
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
  async health(): Promise<Record<string, unknown>> { await this.watchdogTick(); const [tasks, implementationExecutors] = await Promise.all([Promise.all((await this.store.listTasks()).map((task) => this.getTask(task.id))), discoverImplementationExecutors()]); const now = Date.now(); const active = tasks.filter((task) => Boolean(this.liveWorker(task))); const ages = active.map((t) => now - Date.parse(t.progress.lastHeartbeatAt ?? t.updatedAt)); const stalled = tasks.filter((t) => t.progress.workerStatus === "stalled" || t.recovery?.cleanupStatus === "pending" || t.recovery?.cleanupStatus === "detached"); const implementationReady = implementationExecutors.some((item) => item.status === "ready"); return { schemaVersion: 1, service: { status: "healthy", localOnly: true }, readiness: { acceptingNewTasks: true, acceptingImplementationTasks: implementationReady, openrouter: openRouterReadiness(), status: stalled.length || !implementationReady ? "ready_with_degraded_capabilities" : "ready" }, implementationExecutors: publicImplementationExecutors(implementationExecutors), tasks: { active: active.length, cleanupPending: tasks.filter((t) => t.recovery?.cleanupStatus === "pending").length, awaitingOwnerDecisions: tasks.filter((t) => t.status === "awaiting_owner_decision").length, interrupted: tasks.filter((t) => t.status === "interrupted").length, stalled: stalled.length, oldestHeartbeatAgeMs: ages.length ? Math.max(...ages) : 0 } }; }
  private async beginAttempt(task: ControlTaskRecord, operation: "execution" | "continuation", retrySource?: string): Promise<void> {
    const executionId = randomUUID(); const attempt = task.execution.attempt + 1; const now = new Date();
    let artifactRoot = task.artifactRoot; let specPath = task.specPath;
    if (operation === "execution") {
      artifactRoot = join(this.store.taskDir(task.id), "attempts", String(attempt), "artifacts");
      const canonical = structuredClone(await this.store.readSpec(task.id) ?? {}); canonical.artifacts = { ...object(canonical.artifacts), root: artifactRoot, resultFormat: "normalized-v1" };
      if (task.checkpointRepair) { const execution = object(canonical.execution); const phases = object(execution.phaseBudgets); const routing = object(canonical.providerRouting); const tokenBudget = object(routing.tokenBudget); const routingPhases = object(tokenBudget.perPhase); const additional = task.checkpointRepair.additionalProviderTokens; const total = Number.isInteger(execution.maxProviderTokens) ? Number(execution.maxProviderTokens) : 100_000; const repair = Number.isInteger(phases.repair) ? Number(phases.repair) : Math.floor(total * 0.2); canonical.execution = { ...execution, maxProviderTokens: Math.min(implementationExecutorContract.maxLimits.providerTokens, total + additional), phaseBudgets: { ...phases, repair: Math.min(implementationExecutorContract.maxLimits.providerTokens, repair + additional) } }; if (routing.provider === "openrouter") { const routingTotal = Number.isInteger(tokenBudget.total) ? Number(tokenBudget.total) : total; const routingRepair = Number.isInteger(routingPhases.repair) ? Number(routingPhases.repair) : 0; const nextRoutingTotal = Math.min(implementationExecutorContract.maxLimits.providerTokens, routingTotal + additional); const routingDelta = nextRoutingTotal - routingTotal; canonical.providerRouting = { ...routing, tokenBudget: { ...tokenBudget, total: nextRoutingTotal, perPhase: { ...routingPhases, repair: Math.min(implementationExecutorContract.maxLimits.providerTokens, routingRepair + routingDelta) } } }; } }
      specPath = await this.store.writeAttemptSpec(task.id, attempt, canonical);
    } else if (retrySource) {
      const previousRoot = artifactRoot; artifactRoot = join(this.store.taskDir(task.id), "attempts", String(attempt), "artifacts");
      await cp(previousRoot, artifactRoot, { recursive: true, force: true }); await rm(join(artifactRoot, "results.json"), { force: true });
    }
    task.artifactRoot = artifactRoot; task.specPath = specPath; task.status = operation === "continuation" ? "continuing" : "running"; task.startedAt ??= now.toISOString(); task.updatedAt = now.toISOString(); task.finishedAt = null; task.error = null; task.recovery = null;
    const effectiveTimeoutMs = task.progress.timeoutMs;
    task.progress = { phase: operation === "continuation" ? "continuation" : "task_execution", operation, startedAt: now.toISOString(), updatedAt: now.toISOString(), lastHeartbeatAt: now.toISOString(), executionId, attempt, workerStatus: "active", timeoutMs: effectiveTimeoutMs, deadlineAt: new Date(now.getTime() + effectiveTimeoutMs).toISOString(), summary: `${operation} worker active`, diagnostic: "Durable execution lease and worker promise are live.", agreement: task.progress.agreement ?? projectAgreementLifecycle(task) };
    task.execution.attempt = attempt; task.execution.lease = { executionId, attempt, operation, state: "active", startedAt: now.toISOString(), revokedAt: null, cleanupDeadlineAt: null };
    if (operation === "execution" && task.checkpointRepair) task.checkpointRepair.repairExecutionId = executionId;
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
      const repair = task.checkpointRepair && task.checkpointRepair.repairExecutionId === executionId ? task.checkpointRepair : null;
      const rawWork: Promise<unknown> = operation === "continuation" ? this.operations.continueExecution({ run: task.artifactRoot, timeoutMs: task.progress.timeoutMs }) : this.operations.runTaskSpec(task.specPath, { signal: worker.controller.signal, attempt: task.progress.attempt, executionId, executionAgreementId: task.executionAgreement?.agreementId, ...(task.executionAgreement ? { executionAgreement: task.executionAgreement } : {}), ...(repair ? { checkpointRepair: { patchPath: repair.checkpointPatchPath ?? join(repair.checkpointArtifactRoot, "checkpoints", repair.checkpointId, "patch.diff"), checkpointId: repair.checkpointId, checkpointDigest: repair.checkpointDigest, repairIntent: repair.repairIntent } } : {}), onProgress: (phase, detail) => this.updateProgress(id, executionId, phase, detail) });
      const work = rawWork.then((value) => { this.settledExecutions.add(executionId); return value; }, (error) => { this.settledExecutions.add(executionId); throw error; });
      await abortable(work, worker.controller.signal); if (worker.cancelled) return;
      await this.withLock(id, async () => { const current = await this.readTask(id); if (!this.executionIsCurrent(current, executionId)) return; await this.refreshFromResult(current, executionId); });
    }
    catch (error) { const currentWorker = this.active.get(id); if (currentWorker?.executionId === executionId && !currentWorker.cancelled) await this.withLock(id, async () => this.failTask(id, executionId, error)); } finally { clearInterval(heartbeat); }
  }
  private async heartbeat(id: string, executionId: string): Promise<void> { await this.withLock(id, async () => { const worker = this.active.get(id); if (!worker || worker.executionId !== executionId || worker.cancelled) return; const task = await this.readTask(id); if (!["running", "continuing"].includes(task.status) || !this.executionIsCurrent(task, executionId)) return; const now = new Date().toISOString(); task.updatedAt = now; task.progress.updatedAt = now; task.progress.lastHeartbeatAt = now; task.progress.workerStatus = "active"; task.progress.summary = `${task.progress.operation} worker active`; await this.store.saveTask(task); const last = this.journalHeartbeats.get(id) ?? 0; if (Date.now() - last >= 30_000) { await this.store.appendEvent(id, { at: now, type: "heartbeat", detail: task.progress.phase, executionId }); this.journalHeartbeats.set(id, Date.now()); } }); }
  private async updateProgress(id: string, executionId: string, phase: string, detail: string): Promise<void> { await this.withLock(id, async () => { const task = await this.readTask(id); if (!this.executionIsCurrent(task, executionId)) return; const now = new Date().toISOString(); task.progress = { ...task.progress, phase, updatedAt: now, lastHeartbeatAt: now, summary: detail, diagnostic: null }; task.updatedAt = now; await this.persist(task, "phase_started", `${phase}: ${detail}`); }); }
  private async refreshFromResult(task: ControlTaskRecord, executionId: string): Promise<void> { const rawResult = await this.store.readResult(task); if (!rawResult) return this.failTask(task.id, executionId, new Error("RunForge execution finished without results.json.")); const result = task.executionAgreement ? settleAcceptedAgreement(rawResult, task.executionAgreement) : rawResult; const status = String(result.status ?? "failed"); const successful = ["completed", "workflow_completed", "runforge_scope_completed", "awaiting_external_session"].includes(status); const gate = object(result.ownerGate); task.status = gate.required === true || status === "awaiting_owner_decision" || status === "awaiting_owner" || status === "blocked" ? "awaiting_owner_decision" : successful ? "completed" : "failed"; task.ownerGate = { required: gate.required === true, status: String(gate.status ?? "unknown"), ...(typeof gate.reason === "string" ? { reason: gate.reason } : {}) }; if (task.status === "awaiting_owner_decision") await this.ensureContinuationSnapshot(task); if (task.status === "completed" && task.continuation.decisionId) task.continuation.state = "consumed"; if (task.status === "completed" && task.publicationRequested === "draft-pr") task.publicationGate = { required: true, status: "awaiting_owner_decision", reason: "Remote publication requires a separate decision." }; task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.progress = { ...task.progress, updatedAt: task.updatedAt, lastHeartbeatAt: task.updatedAt, workerStatus: "finished", summary: `Task ${task.status}.`, diagnostic: "Worker completed and generation-matched results.json was accepted." }; task.progress.agreement = projectAgreementLifecycle(task, result); this.finishAttempt(task, task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "completed"); if (task.execution.lease) task.execution.lease.state = "finished"; await this.store.writePublishedResult(task.id, executionId, result); await this.persist(task, task.status === "completed" ? "task_completed" : task.status === "awaiting_owner_decision" ? "owner_gate_created" : "task_failed", task.status); }
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
    const artifacts = await readdir(task.artifactRoot, { recursive: true }).catch(() => [] as string[]); const checkpoints = await listDurableCheckpoints(task.artifactRoot);
    const spec = await this.store.readSpec(task.id); const criteria = object(object(spec).task).acceptanceCriteria;
    const incomplete = Array.isArray(criteria) ? criteria.map(String) : ["Execution did not reach a trusted terminal result."];
    await this.store.writePublishedResult(task.id, executionId, {
      schemaVersion: 1, taskId: task.id, status: "interrupted", lastCompletedPhase: task.recovery?.lastPhase ?? task.progress.phase,
      interruption: { reason: task.recovery?.reason, originalExecutionId: executionId, lastHeartbeatAt: task.progress.lastHeartbeatAt, deadlineAt: task.progress.deadlineAt },
      execution: { id: executionId, attempt: task.progress.attempt, operation: task.progress.operation },
      targetMutation: { status: "not_inferred", assertion: "Interrupted execution never implies that target mutations completed." },
      artifacts: { root: task.artifactRoot, created: artifacts.sort() }, artifact: { status: checkpoints.length ? "available" : "unavailable", checkpoints: checkpoints.map((item) => ({ id: item.id, manifest: item.manifest, patch: `checkpoints/${item.id}/patch.diff` })) }, handoffPackage: { status: checkpoints.length ? "available" : "unavailable", latestSafePatch: checkpoints.at(-1) ? `checkpoints/${checkpoints.at(-1)!.id}/patch.diff` : null, bestValidatedCheckpoint: checkpoints.at(-1)?.id ?? null, baseSha: checkpoints.at(-1)?.manifest.baseSha ?? null, nextResponsibleParty: "external_session", exactNextAction: checkpoints.length ? "Accept or apply the last durable checkpoint; cancellation did not delete it." : "Inspect interruption evidence." }, validations: { incomplete }, recovery: task.recovery,
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
    const snapshot = { schemaVersion: 1, ...context.binding, authority: task.authority, executionAgreement: task.executionAgreement, validationNegotiation: task.validationNegotiation, decisionId: task.continuation.decisionId, executionIdentity: task.continuation.sourceExecutionId, taskSpec: context.spec, specPath: basename(task.specPath), runtime: object(context.spec.runtime), bindingHash: continuationBindingHash(context.binding, task.authority, context.spec), native };
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
      && JSON.stringify(snapshot.taskSpec) === JSON.stringify(context.spec) && JSON.stringify(snapshot.executionAgreement) === JSON.stringify(task.executionAgreement) && JSON.stringify(snapshot.validationNegotiation) === JSON.stringify(task.validationNegotiation) && nativeMatchesContinuationContext(object(snapshot.native), binding);
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
  private campaignsDir(): string { return join(this.store.root, "campaigns"); }
  private campaignPath(id: string): string { return join(this.campaignsDir(), `${id}.json`); }
  private async saveCampaign(campaign: CampaignRecord): Promise<void> { await mkdir(this.campaignsDir(), { recursive: true }); const destination = this.campaignPath(campaign.id); const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(campaign, null, 2) + "\n", "utf8"); await rename(temp, destination); }
  private async readCampaign(id: string): Promise<CampaignRecord | null> { try { return JSON.parse(await readFile(this.campaignPath(id), "utf8")) as CampaignRecord; } catch { return null; } }
  private async readCampaigns(): Promise<CampaignRecord[]> {
    await mkdir(this.campaignsDir(), { recursive: true });
    const names = (await readdir(this.campaignsDir())).filter((item) => item.endsWith(".json"));
    const entries = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(this.campaignsDir(), name), "utf8")) as CampaignRecord));
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private reconcileCampaignResult(campaign: CampaignRecord): Record<string, unknown> { return { schemaVersion: 1, campaignId: campaign.id, status: campaign.status, usage: campaign.usage, failures: campaign.failures, children: Object.values(campaign.children).map((child) => ({ nodeId: child.nodeId, taskId: child.taskId, status: child.status, startedAt: child.startedAt, finishedAt: child.finishedAt, error: child.error })), evidence: Object.values(campaign.children).filter((child) => child.evidence).map((child) => ({ nodeId: child.nodeId, evidence: child.evidence })) }; }
}
function aggregateUsageFromValue(value: unknown): { tokens: number; costUsd: number } { const totals = { tokens: 0, costUsd: 0 }; const visit = (current: unknown): void => { if (Array.isArray(current)) current.forEach(visit); else if (current && typeof current === "object") for (const [key, entry] of Object.entries(current as Record<string, unknown>)) { if (typeof entry === "number" && Number.isFinite(entry) && /(token|tokens|tokenUsage|totalTokens)/i.test(key)) totals.tokens += entry; else if (typeof entry === "number" && Number.isFinite(entry) && /(cost|costUsd|usd)/i.test(key)) totals.costUsd += entry; else visit(entry); } }; visit(value); return totals; }
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
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} is required.`); return value.trim(); }
function continuationBindingHash(binding: ContinuationBinding, authority: ControlAuthority, taskSpec: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify({ binding, authority, taskSpec })).digest("hex"); }
function nativeMatchesContinuationContext(native: Record<string, unknown>, binding: ContinuationBinding): boolean {
  const sourceBefore = object(native.sourceBefore);
  return native.schemaVersion === 1 && native.taskId === binding.taskId && native.repo === binding.repository && native.workingDirectory === binding.workingDirectory && native.sourceBranch === binding.sourceBranch && sourceBefore.path === binding.repository && sourceBefore.head === binding.sourceSha;
}
function decisionRecord(decisionId: string, kind: "owner" | "publication", decision: string, response: Record<string, unknown>): DecisionRecord { return { decisionId, kind, decision, response, createdAt: new Date().toISOString() }; }
function safeMessage(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return redactPublicValue(message).slice(0, 500); }
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
