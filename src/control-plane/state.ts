import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ControlTaskRecord, ProjectRecord } from "./contracts.js";

export class ControlPlaneStore {
  constructor(public readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "tasks"), { recursive: true });
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

  taskDir(id: string): string { return join(this.root, "tasks", id); }
  taskPath(id: string): string { return join(this.taskDir(id), "state.json"); }
  async getTask(id: string): Promise<ControlTaskRecord | null> { return this.readJson<ControlTaskRecord | null>(this.taskPath(id), null); }
  async saveTask(task: ControlTaskRecord): Promise<void> { await this.writeJson(this.taskPath(task.id), task); }
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

  async writeServiceInfo(value: Record<string, unknown>): Promise<void> { await this.writeJson(join(this.root, "service.json"), value); }
  async readServiceInfo(): Promise<Record<string, unknown> | null> { return this.readJson(join(this.root, "service.json"), null); }

  private async recoverInterruptedTasks(): Promise<void> {
    const tasks = await this.listTasks();
    for (const task of tasks.filter((item) => ["queued", "running", "continuing"].includes(item.status))) {
      task.status = "interrupted";
      task.updatedAt = new Date().toISOString();
      task.ownerGate = { required: true, status: "awaiting_owner_decision", reason: "The service restarted while execution was in progress; success was not inferred." };
      task.events.push({ at: task.updatedAt, type: "recovered_interrupted" });
      await this.saveTask(task);
    }
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
