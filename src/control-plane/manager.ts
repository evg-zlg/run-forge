import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { buildDoctorReport } from "../product/doctor.js";
import { runTaskSpecFile } from "../product/task-spec-runner.js";
import { loadTaskSpecV2 } from "../product/task-spec-v2.js";
import { continueExternalExecution, recordOwnerDecision } from "../run/external-execution.js";
import { ControlPlaneError, type ControlAuthority, type ControlTaskRecord, type DecisionRecord, type ProjectRecord } from "./contracts.js";
import { ControlPlaneStore } from "./state.js";

export class ControlPlaneManager {
  private readonly active = new Set<string>();
  constructor(
    public readonly store: ControlPlaneStore,
    private readonly operations: {
      runTaskSpec: typeof runTaskSpecFile;
      recordOwnerDecision: typeof recordOwnerDecision;
      continueExecution: typeof continueExternalExecution;
    } = { runTaskSpec: runTaskSpecFile, recordOwnerDecision, continueExecution: continueExternalExecution }
  ) {}

  async initialize(): Promise<void> { await this.store.initialize(); }

  async inspectProject(input: { path: string; workingDirectory: string; register: boolean; runtime?: "local" | "docker"; dependencyPreparation?: "required" | "if-needed" | "disabled" | "reuse-existing" }): Promise<Record<string, unknown>> {
    const report = await buildDoctorReport({ repo: input.path, workingDirectory: input.workingDirectory, runtime: input.runtime, dependencyPreparation: input.dependencyPreparation, publication: "none" });
    let project: ProjectRecord | null = null;
    if (input.register && report.targetRepository?.repositoryRoot && report.targetRepository.workingDirectory) {
      const now = new Date().toISOString();
      const repository = await realpath(report.targetRepository.repositoryRoot);
      const existing = (await this.store.listProjects()).find((item) => item.repository === repository && item.workingDirectory === report.targetRepository!.workingDirectory);
      project = { id: this.store.projectId(repository, report.targetRepository.workingDirectory), repository, workingDirectory: report.targetRepository.workingDirectory, createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.store.saveProject(project);
    }
    return { project, readiness: report };
  }

  async createTask(input: { projectId?: string; taskSpec: Record<string, unknown>; authority: ControlAuthority; publicationRequested: "none" | "draft-pr" }): Promise<ControlTaskRecord> {
    const raw = structuredClone(input.taskSpec);
    const project = input.projectId ? await this.requireProject(input.projectId) : null;
    const taskId = requiredString(raw.taskId, "taskSpec.taskId");
    if (await this.store.getTask(taskId)) throw new ControlPlaneError(409, "task_exists", `Task already exists: ${taskId}`);
    if (!input.authority.inspect) throw new ControlPlaneError(403, "authority_denied", "inspect authority is required to create a task.");
    if (project) raw.target = { repository: project.repository, workingDirectory: project.workingDirectory };
    if (!raw.target) throw new ControlPlaneError(422, "project_required", "Provide projectId or taskSpec.target.");
    const authorityRaw = object(raw.authority);
    const profile = authorityRaw.profile ?? "read-only";
    if (profile === "bounded-implementation" && !input.authority.implementation) throw new ControlPlaneError(403, "authority_denied", "TaskSpec requests implementation but control-plane implementation authority is false.");
    const requestedInSpec = object(raw.git).publication;
    const publicationRequested = input.publicationRequested === "draft-pr" || requestedInSpec === "draft-pr" ? "draft-pr" : "none";
    raw.git = { publication: "none" };
    raw.merge = { policy: "never" };
    raw.deploy = { policy: "never" };
    const artifactRoot = join(this.store.taskDir(taskId), "artifacts");
    raw.artifacts = { ...object(raw.artifacts), root: artifactRoot, resultFormat: "normalized-v1" };
    const specPath = await this.store.writeSpec(taskId, raw);
    try { await loadTaskSpecV2(specPath); }
    catch (error) { throw new ControlPlaneError(422, "invalid_task_spec", error instanceof Error ? error.message : String(error)); }
    const now = new Date().toISOString();
    const task: ControlTaskRecord = {
      id: taskId, projectId: project?.id ?? null, status: "queued", specPath, artifactRoot, authority: input.authority, publicationRequested,
      publicationGate: publicationRequested === "draft-pr" ? { required: true, status: "blocked_until_implementation_completes", reason: "Remote publication is a separate decision and was removed from implementation execution." } : { required: false, status: "not_requested" },
      ownerGate: { required: false, status: "not_required" }, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, error: null, decisions: [], events: [{ at: now, type: "accepted" }]
    };
    await this.store.saveTask(task);
    this.start(task.id);
    return task;
  }

  async getTask(id: string): Promise<ControlTaskRecord> { const task = await this.store.getTask(id); if (!task) throw new ControlPlaneError(404, "task_not_found", `Task not found: ${id}`); return task; }

  async getResult(id: string): Promise<Record<string, unknown>> {
    const task = await this.getTask(id);
    const result = await this.store.readResult(task);
    if (!result) throw new ControlPlaneError(404, "result_not_ready", `Result is not available for task ${id}.`);
    return { ...result, controlPlane: { status: task.status, ownerGate: task.ownerGate, publicationGate: task.publicationGate, authority: task.authority, events: task.events } };
  }

  async ownerDecision(id: string, input: { decisionId: string; decision: string; targetBranch?: string; note: string }): Promise<Record<string, unknown>> {
    const task = await this.getTask(id);
    const duplicate = task.decisions.find((item) => item.kind === "owner" && item.decisionId === input.decisionId);
    if (duplicate) return { idempotentReplay: true, ...duplicate.response };
    if (!task.ownerGate.required) throw new ControlPlaneError(409, "owner_gate_not_open", "This task has no open implementation owner gate.");
    if (["approve", "continue"].includes(input.decision) && !task.authority.implementation) throw new ControlPlaneError(403, "authority_denied", "Implementation authority is required for an approving owner decision.");
    const targetBranch = input.targetBranch ?? `runforge/${task.id.toLowerCase()}`;
    const recorded = await this.operations.recordOwnerDecision({ run: task.artifactRoot, decision: input.decision, targetMode: "controlled-worktree", targetBranch, ownerNote: input.note });
    const response = { decisionId: input.decisionId, runforgeDecisionId: recorded.decisionId, artifact: recorded.path, decision: input.decision, targetBranch };
    task.decisions.push(decisionRecord(input.decisionId, "owner", input.decision, response));
    task.ownerGate = { required: input.decision === "approve" || input.decision === "continue", status: input.decision === "reject" ? "rejected" : input.decision === "hold" ? "on_hold" : "decision_recorded" };
    task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, type: "owner_decision", detail: input.decision });
    await this.store.saveTask(task);
    return response;
  }

  async continueTask(id: string): Promise<ControlTaskRecord> {
    const task = await this.getTask(id);
    if (this.active.has(id)) throw new ControlPlaneError(409, "task_active", "Task execution is already active.");
    if (!["awaiting_owner_decision", "interrupted"].includes(task.status)) throw new ControlPlaneError(409, "task_not_continuable", `Task status '${task.status}' cannot be continued.`);
    if (!task.decisions.some((item) => item.kind === "owner" && ["approve", "continue"].includes(item.decision))) throw new ControlPlaneError(409, "owner_decision_required", "An approving owner decision is required before continuation.");
    task.status = "continuing"; task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, type: "continuation_started" });
    await this.store.saveTask(task); this.active.add(id);
    void this.operations.continueExecution({ run: task.artifactRoot, timeoutMs: 300_000 }).then(async () => {
      const current = await this.getTask(id); await this.refreshFromResult(current, "continuation_completed");
    }).catch(async (error) => this.failTask(id, error)).finally(() => this.active.delete(id));
    return task;
  }

  async publicationDecision(id: string, input: { decisionId: string; decision: string; note: string }): Promise<Record<string, unknown>> {
    const task = await this.getTask(id);
    const duplicate = task.decisions.find((item) => item.kind === "publication" && item.decisionId === input.decisionId);
    if (duplicate) return { idempotentReplay: true, ...duplicate.response };
    if (!task.publicationGate.required) throw new ControlPlaneError(409, "publication_gate_not_open", "This task has no publication gate.");
    const permitted = task.authority.remotePush && task.authority.draftPublication;
    const status = input.decision === "approve" ? permitted ? "approved_adapter_required" : "blocked_missing_authority" : input.decision === "reject" ? "rejected" : "on_hold";
    const response = { decisionId: input.decisionId, decision: input.decision, status, executed: false, providerCalls: false, reason: status === "blocked_missing_authority" ? "remotePush and draftPublication authority are required." : "Publication execution is intentionally separate from implementation." };
    task.decisions.push(decisionRecord(input.decisionId, "publication", input.decision, response));
    task.publicationGate = { required: status !== "rejected", status, reason: response.reason };
    task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, type: "publication_decision", detail: status });
    await this.store.saveTask(task);
    return response;
  }

  private start(id: string): void {
    this.active.add(id);
    void this.execute(id).finally(() => this.active.delete(id));
  }

  private async execute(id: string): Promise<void> {
    const task = await this.getTask(id); task.status = "running"; task.startedAt = new Date().toISOString(); task.updatedAt = task.startedAt; task.events.push({ at: task.startedAt, type: "execution_started" }); await this.store.saveTask(task);
    try { await this.operations.runTaskSpec(task.specPath); await this.refreshFromResult(await this.getTask(id), "execution_completed"); }
    catch (error) { await this.failTask(id, error); }
  }

  private async refreshFromResult(task: ControlTaskRecord, event: string): Promise<void> {
    const result = await this.store.readResult(task);
    if (!result) return this.failTask(task.id, new Error("RunForge execution finished without results.json."));
    const status = String(result.status ?? "failed");
    task.status = status === "awaiting_owner_decision" || status === "blocked" ? "awaiting_owner_decision" : status === "completed" ? "completed" : "failed";
    const gate = object(result.ownerGate); task.ownerGate = { required: gate.required === true, status: String(gate.status ?? "unknown"), ...(typeof gate.reason === "string" ? { reason: gate.reason } : {}) };
    if (task.status === "completed" && task.publicationRequested === "draft-pr") task.publicationGate = { required: true, status: "awaiting_owner_decision", reason: "Implementation completed locally; remote push and draft publication require a separate decision and authority." };
    task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.events.push({ at: task.finishedAt, type: event, detail: task.status }); await this.store.saveTask(task);
  }

  private async failTask(id: string, error: unknown): Promise<void> { const task = await this.getTask(id); task.status = "failed"; task.error = error instanceof Error ? error.message : String(error); task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.events.push({ at: task.finishedAt, type: "execution_failed", detail: task.error }); await this.store.saveTask(task); }
  private async requireProject(id: string): Promise<ProjectRecord> { const project = await this.store.getProject(id); if (!project) throw new ControlPlaneError(404, "project_not_found", `Project not found: ${id}`); return project; }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ControlPlaneError(400, "invalid_request", `${name} is required.`); return value.trim(); }
function decisionRecord(decisionId: string, kind: "owner" | "publication", decision: string, response: Record<string, unknown>): DecisionRecord { return { decisionId, kind, decision, response, createdAt: new Date().toISOString() }; }
