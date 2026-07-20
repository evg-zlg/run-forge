import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExecutionAgreement } from "../product/execution-agreement.js";
import type { ControlTaskRecord, ProjectRecord } from "./contracts.js";

export class ControlPlaneStore {
  constructor(public readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "tasks"), { recursive: true });
    await mkdir(join(this.root, "execution-agreements"), { recursive: true });
    await this.recoverInterruptedTasks();
  }

  projectId(repository: string, workingDirectory: string): string {
    return `prj_${createHash("sha256").update(`${repository}\0${workingDirectory}`).digest("hex").slice(0, 16)}`;
  }

  async listProjects(): Promise<ProjectRecord[]> { return this.readJson<ProjectRecord[]>(join(this.root, "projects.json"), []); }
  async getProject(id: string): Promise<ProjectRecord | null> { return (await this.listProjects()).find((item) => item.id === id) ?? null; }
  async saveProject(project: ProjectRecord): Promise<void> {
    const projects = await this.listProjects();
    const index = projects.findIndex((item) => item.id === project.id);
    if (index === -1) projects.push(project); else projects[index] = project;
    await this.writeJson(join(this.root, "projects.json"), projects);
  }

  agreementPath(id: string): string { return join(this.root, "execution-agreements", `${id}.json`); }
  async getAgreement(id: string): Promise<ExecutionAgreement | null> { return this.readJson<ExecutionAgreement | null>(this.agreementPath(id), null); }
  async saveAgreement(agreement: ExecutionAgreement): Promise<void> { await this.writeJson(this.agreementPath(agreement.agreementId), agreement); }

  taskDir(id: string): string { return join(this.root, "tasks", id); }
  taskPath(id: string): string { return join(this.taskDir(id), "state.json"); }
  async getTask(id: string): Promise<ControlTaskRecord | null> { return this.readJson<ControlTaskRecord | null>(this.taskPath(id), null); }
  async saveTask(task: ControlTaskRecord): Promise<void> { await this.writeJson(this.taskPath(task.id), task); }
  async appendEvent(id: string, event: { at: string; type: string; detail?: string; executionId?: string }): Promise<void> {
    const path = join(this.taskDir(id), "journal.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify({ schemaVersion: 1, taskId: id, ...event }) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  continuationPath(id: string): string { return join(this.taskDir(id), "continuation-state.json"); }
  async saveContinuation(id: string, value: Record<string, unknown>): Promise<void> { await this.writeJson(this.continuationPath(id), value); }
  async readContinuation(id: string): Promise<Record<string, unknown> | null> { return this.readJson(this.continuationPath(id), null); }
  async readSpec(id: string): Promise<Record<string, unknown> | null> { return this.readJson(join(this.taskDir(id), "task-spec.json"), null); }
  async writeAttemptSpec(id: string, attempt: number, spec: Record<string, unknown>): Promise<string> {
    const path = join(this.taskDir(id), "attempts", String(attempt), "task-spec.json");
    await this.writeJson(path, spec);
    return path;
  }
  async listTasks(): Promise<ControlTaskRecord[]> {
    const names = await readdir(join(this.root, "tasks"), { withFileTypes: true }).catch(() => []);
    const tasks = await Promise.all(names.filter((item) => item.isDirectory()).map((item) => this.getTask(item.name)));
    return tasks.filter((item): item is ControlTaskRecord => item !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeSpec(id: string, spec: Record<string, unknown>): Promise<string> {
    const path = join(this.taskDir(id), "task-spec.json");
    await this.writeJson(path, spec);
    return path;
  }

  async readResult(task: ControlTaskRecord): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown> | null>(join(task.artifactRoot, "results.json"), null);
  }
  async writePublishedResult(id: string, executionId: string, result: Record<string, unknown>): Promise<void> {
    const task = await this.getTask(id);
    const durableResult = task?.validationNegotiation ? { ...result, validationNegotiation: task.validationNegotiation } : result;
    await this.writeJson(join(this.taskDir(id), "result.json"), { executionId, result: durableResult });
  }
  async readPublishedResult(id: string): Promise<{ executionId: string; result: Record<string, unknown> } | null> {
    return this.readJson(join(this.taskDir(id), "result.json"), null);
  }

  async writeServiceInfo(value: Record<string, unknown>): Promise<void> { await this.writeJson(join(this.root, "service.json"), value); }
  async readServiceInfo(): Promise<Record<string, unknown> | null> { return this.readJson(join(this.root, "service.json"), null); }

  private async recoverInterruptedTasks(): Promise<void> {
    const tasks = await this.listTasks();
    for (const task of tasks) {
      const journal = await this.readJournal(task.id);
      const lastInterrupted = [...journal].reverse().find((event) => event.type === "task_interrupted");
      const afterInterruption = lastInterrupted ? journal.slice(journal.lastIndexOf(lastInterrupted) + 1) : [];
      const replacementStarted = Boolean(lastInterrupted && afterInterruption.some((event) => ["retry_requested", "task_started", "continuation_started"].includes(event.type) && event.executionId !== lastInterrupted.executionId));
      const lateTerminal = Boolean(lastInterrupted && ["completed", "failed"].includes(task.status) && !replacementStarted && afterInterruption.some((event) => ["task_completed", "task_failed"].includes(event.type) && event.executionId === lastInterrupted.executionId));
      const lateTerminalStatus = task.status;
      const journalWins = lateTerminal || Boolean(["queued", "running", "continuing"].includes(task.status) && lastInterrupted && !afterInterruption.some((event) => ["task_started", "continuation_started", "task_completed", "task_failed"].includes(event.type)));
      if (!journalWins && !["queued", "running", "continuing", "interrupted"].includes(task.status)) continue;
      const wasInFlight = ["queued", "running", "continuing"].includes(task.status);
      const reason = journalWins ? String(lastInterrupted?.detail ?? "journal_reconstruction") : wasInFlight ? "service_restart" : task.recovery?.reason ?? "service_restart";
      task.status = "interrupted";
      task.updatedAt = new Date().toISOString();
      task.events ??= [];
      if (wasInFlight) task.events.push({ at: task.updatedAt, type: "recovered_interrupted" });
      if (lateTerminal) task.events.push({ at: task.updatedAt, type: "late_worker_terminal_ignored", detail: `Ignored ${lateTerminalStatus} from revoked execution ${lastInterrupted?.executionId ?? "unknown"}.` });
      task.progress = { ...(task.progress ?? fallbackProgress(task)), attempt: task.progress?.attempt ?? task.execution?.attempt ?? 1, updatedAt: task.updatedAt, workerStatus: "lost", diagnostic: "Worker identity was lost during control-plane restart." };
      task.execution ??= { attempt: task.progress.attempt, lease: null, attempts: [], lastRetry: null };
      if (task.execution.lease) {
        task.execution.lease.state = "revoked";
        task.execution.lease.revokedAt ??= task.updatedAt;
        task.execution.lease.cleanupDeadlineAt = task.updatedAt;
      }
      task.recovery = { reason, lastPhase: task.progress.phase, lastHeartbeatAt: task.progress.lastHeartbeatAt, originalExecutionId: task.progress.executionId, actions: ["retry", "cancel"], retryAvailable: true, cleanupStatus: "not_required", operation: `/v1/tasks/${task.id}/retry` };
      await this.saveTask(task);
      await this.writePublishedResult(task.id, task.progress.executionId ?? "unknown", interruptedResult(task));
      if (wasInFlight && !journalWins) await this.appendEvent(task.id, { at: task.updatedAt, type: "task_interrupted", detail: reason, executionId: task.progress.executionId ?? undefined });
      if (lateTerminal) await this.appendEvent(task.id, { at: task.updatedAt, type: "late_worker_terminal_ignored", detail: reason, executionId: task.progress.executionId ?? undefined });
    }
  }

  private async readJournal(id: string): Promise<Array<{ type: string; detail?: string; executionId?: string }>> {
    try { return (await readFile(join(this.taskDir(id), "journal.jsonl"), "utf8")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = resolve(dirname(path), `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  }
}

function fallbackProgress(task: ControlTaskRecord): ControlTaskRecord["progress"] {
  return { phase: "unknown", operation: "execution", startedAt: task.startedAt, updatedAt: task.updatedAt, lastHeartbeatAt: task.updatedAt, executionId: null, attempt: 1, workerStatus: "lost", timeoutMs: 300_000, deadlineAt: null, summary: "Execution interrupted by service restart.", diagnostic: null };
}

function interruptedResult(task: ControlTaskRecord): Record<string, unknown> {
  return {
    schemaVersion: 1, taskId: task.id, status: "interrupted", lastCompletedPhase: task.recovery?.lastPhase ?? task.progress.phase,
    interruption: { reason: task.recovery?.reason, originalExecutionId: task.progress.executionId, lastHeartbeatAt: task.progress.lastHeartbeatAt, deadlineAt: task.progress.deadlineAt },
    targetMutation: { status: "not_inferred", assertion: "Service restart never infers mutation completion." }, artifacts: { root: task.artifactRoot, created: [] },
    validations: { incomplete: ["Execution did not reach a trusted terminal result."] }, recovery: task.recovery,
    safetyAssertions: { staleLeaseRevoked: true, lateWorkerResultIgnored: true, providerCallsInferred: false }, nextAction: task.recovery?.operation
  };
}
