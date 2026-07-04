import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import { validateCommandSafety } from "./command-safety.js";
import { runOneCommand } from "./external-command-check-exec.js";
import {
  diffWorkspaceSnapshots,
  gitSnapshot,
  mutationVerdictFor,
  prepareWorkspace,
  snapshotWorkspaceFiles,
  unknownWorkspaceChangeSummary,
  type WorkspaceChangeSummary,
  type WorkspaceFileSnapshot
} from "./external-command-check-git.js";
import {
  artifactTypeFor,
  buildSafetyReport,
  writeArtifacts,
  writePacketManifest,
  type ArtifactRecord
} from "./external-command-check-packet.js";
import type {
  CliExitPolicy,
  CommandPolicy,
  CommandResult,
  ExternalCheckStatus,
  ExternalCommandCheckOptions,
  ExternalCommandCheckResult,
  SafetyReport
} from "./external-command-check-types.js";
import { externalCheckSchemaVersion } from "./external-command-check-types.js";

export type { ExternalCommandCheckOptions, ExternalCommandCheckResult } from "./external-command-check-types.js";

const defaultTimeoutMs = 120_000;
const defaultMaxLogBytes = 1_000_000;
const commandPolicy: CommandPolicy = {
  onFailure: "continue",
  finalStatusRule: "failed_if_any_command_failed_or_timed_out"
};

export async function runExternalCommandCheck(options: ExternalCommandCheckOptions): Promise<ExternalCommandCheckResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const repoPath = resolve(options.repo);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxLogBytes = options.maxLogBytes ?? defaultMaxLogBytes;
  const cliExitPolicy = options.exitPolicy ?? "packet";
  const packetDir = join(resolve(options.out ?? defaultOutDir()), "packet");
  const logsDir = join(packetDir, "logs");
  await ensureDir(logsDir);

  const events: Array<Record<string, unknown>> = [];
  const artifactRecords = new Map<string, ArtifactRecord>();
  let eventCounter = 0;
  const emit = (type: string, data: object = {}) => {
    eventCounter += 1;
    const event = {
      schemaVersion: externalCheckSchemaVersion,
      eventId: `${runId}:event:${String(eventCounter).padStart(4, "0")}`,
      runId,
      type,
      time: new Date().toISOString(),
      ...data
    };
    events.push(event);
    return event.eventId;
  };
  const markArtifact = async (artifactPath: string, artifactType = artifactTypeFor(artifactPath)) => {
    const fullPath = join(packetDir, artifactPath);
    const info = await stat(fullPath);
    const hash = createHash("sha256").update(await readFile(fullPath)).digest("hex");
    const record: ArtifactRecord = {
      artifactId: `${runId}:artifact:${artifactPath}`,
      artifactPath,
      artifactType,
      artifactBytes: info.size,
      hash,
      createdAt: new Date().toISOString()
    };
    artifactRecords.set(artifactPath, record);
    emit("artifact_written", record);
  };

  emit("task_received", { taskType: "external_command_check", commandsRequested: options.commands.length });
  emit("run_created", { packetDir, cliExitPolicy });
  emit("route_selected", { route: "external_command_check" });

  await assertDirectory(repoPath, "--repo");
  const originalBefore = await gitSnapshot(repoPath);
  const blockedCommands = blockedCommandReports(options.commands);
  let workspacePath: string | undefined;
  const commandResults: CommandResult[] = [];
  let status: ExternalCheckStatus = "passed";
  let workspaceBefore: WorkspaceFileSnapshot | undefined;

  if (blockedCommands.length > 0) {
    status = "blocked";
    for (const blocked of blockedCommands) {
      const result = blockedResult(blocked, repoPath, runId);
      await writeFile(join(packetDir, result.stdoutPath), "", "utf8");
      await writeFile(join(packetDir, result.stderrPath), `${blocked.reason}\n`, "utf8");
      commandResults.push(result);
      await markArtifact(result.stdoutPath, "log");
      await markArtifact(result.stderrPath, "log");
    }
  } else {
    workspacePath = await prepareWorkspace(repoPath);
    try {
      workspaceBefore = await snapshotWorkspaceFiles(workspacePath);
    } catch (error) {
      emit("workspace_snapshot_failed", { workspacePath, error: errorMessage(error) });
    }
    emit("workspace_prepared", { workspacePath });
    const workerId = `${runId}:worker:command_runner`;
    const workerStartedEventId = emit("worker_started", { workerId, worker: "command_runner" });
    for (let i = 0; i < options.commands.length; i += 1) {
      const index = i + 1;
      const command = options.commands[i]!;
      const commandId = `${runId}:command:${String(index).padStart(3, "0")}`;
      emit("command_started", { parentEventId: workerStartedEventId, workerId, commandId, index, command });
      const result = await runOneCommand({ commandId, index, command, cwd: workspacePath, timeoutMs, maxLogBytes, logsDir });
      commandResults.push(result);
      await markArtifact(result.stdoutPath, "log");
      await markArtifact(result.stderrPath, "log");
      emit("command_finished", {
        parentEventId: workerStartedEventId,
        workerId,
        commandId,
        index,
        command,
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs
      });
    }
    emit("worker_finished", { parentEventId: workerStartedEventId, workerId, worker: "command_runner" });
  }

  const safetyStartedEventId = emit("safety_check_started", { safetyStatus: "started" });
  const originalAfter = await gitSnapshot(repoPath);
  const mutationVerdict = mutationVerdictFor(originalBefore, originalAfter);
  const workspaceChangeSummary = await computeWorkspaceChangeSummary(workspacePath, workspaceBefore);
  status = finalStatus(status, commandResults, mutationVerdict);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const cliExitCode = cliExitCodeFor(cliExitPolicy, status);
  const safetyReport: SafetyReport = buildSafetyReport({
    options,
    runId,
    cliExitPolicy,
    cliExitCode,
    originalBefore,
    originalAfter,
    mutationVerdict,
    workspacePath,
    blockedCommands
  });
  emit("safety_check_finished", { parentEventId: safetyStartedEventId, safetyStatus: "finished", mutationVerdict });

  await writeArtifacts({
    packetDir,
    runId,
    schemaVersion: externalCheckSchemaVersion,
    status,
    startedAt,
    finishedAt,
    durationMs,
    repoPath,
    timeoutMs,
    maxLogBytes,
    originalBefore,
    originalAfter,
    mutationVerdict,
    workspacePath,
    workspaceChangeSummary,
    cliExitPolicy,
    cliExitCode,
    commandPolicy,
    commandResults,
    safetyReport,
    markArtifact
  });
  emit("summary_written", { artifactPath: "summary.md" });
  emit("run_finished", { status });
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await markArtifact("events.jsonl");
  await writePacketManifest(packetDir, artifactRecords);
  await markArtifact("packet-manifest.json");
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  return { runId, status, packetDir, repoPath, workspacePath, cliExitPolicy, cliExitCode, commandResults, safetyReport };
}

export function renderExternalCommandCheckCliSummary(result: ExternalCommandCheckResult): string {
  return [
    "RunForge external check",
    "",
    `Run ID: ${result.runId}`,
    `Status: ${result.status}`,
    `CLI exit policy: ${result.cliExitPolicy}`,
    `CLI exit code: ${result.cliExitCode}`,
    `Repo: ${result.repoPath}`,
    `Packet: ${result.packetDir}`,
    "",
    "Commands:",
    ...result.commandResults.map((command) => `${command.index}. ${command.command} - ${command.status}`),
    "",
    `Original repo: ${result.safetyReport.originalRepoMutationVerdict}`,
    "",
    "Key artifacts:",
    "- summary.md",
    "- command-results.json",
    "- logs/",
    "- events.jsonl",
    "- metrics.json",
    "- packet-manifest.json"
  ].join("\n");
}

function validateOptions(options: ExternalCommandCheckOptions): void {
  if (!options.repo) throw new Error("--repo is required.");
  if (!options.commands || options.commands.length === 0) throw new Error("At least one --command is required.");
  if (options.commands.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (options.maxLogBytes !== undefined && (!Number.isInteger(options.maxLogBytes) || options.maxLogBytes <= 0)) {
    throw new Error("--max-log-bytes must be a positive integer.");
  }
  if (options.exitPolicy !== undefined && !["packet", "command-status"].includes(options.exitPolicy)) {
    throw new Error("--exit-policy must be packet or command-status.");
  }
}

async function assertDirectory(path: string, field: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${field} path is not a directory: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a directory")) throw error;
    throw new Error(`${field} path does not exist: ${path}`);
  }
}

function blockedCommandReports(commands: string[]): Array<{ index: number; command: string; reason: string }> {
  const reports: Array<{ index: number; command: string; reason: string }> = [];
  commands.forEach((command, offset) => {
    const safety = validateCommandSafety(command);
    const policyBlock = blockedExternalCommandReason(command);
    const reason = safety?.reason ?? policyBlock;
    if (reason) reports.push({ index: offset + 1, command, reason });
  });
  return reports;
}

function blockedExternalCommandReason(command: string): string | undefined {
  if (/\bgit\s+push\b/.test(command)) return "Blocked external check command: git push is not allowed.";
  if (/\bgit\s+merge\b/.test(command)) return "Blocked external check command: git merge is not allowed.";
  if (/\bdeploy\b/.test(command)) return "Blocked external check command: deploy commands are not allowed.";
  return undefined;
}

function blockedResult(blocked: { index: number; command: string; reason: string }, cwd: string, runId: string): CommandResult {
  const now = new Date().toISOString();
  return {
    commandId: `${runId}:command:${String(blocked.index).padStart(3, "0")}`,
    index: blocked.index,
    command: blocked.command,
    cwd,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    status: "blocked",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutPath: `logs/command-${String(blocked.index).padStart(3, "0")}.stdout.log`,
    stderrPath: `logs/command-${String(blocked.index).padStart(3, "0")}.stderr.log`,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    blockReason: blocked.reason
  };
}

function finalStatus(current: ExternalCheckStatus, commandResults: CommandResult[], mutationVerdict: string): ExternalCheckStatus {
  if (mutationVerdict === "changed") return "error";
  if (current === "blocked") return "blocked";
  if (commandResults.some((result) => result.status === "timed_out")) return "timed_out";
  if (commandResults.some((result) => result.status === "error")) return "error";
  if (commandResults.some((result) => result.status === "failed")) return "failed";
  return "passed";
}

function defaultOutDir(): string {
  return join(process.cwd(), "artifacts", "external-check");
}

async function computeWorkspaceChangeSummary(
  workspacePath: string | undefined,
  workspaceBefore: WorkspaceFileSnapshot | undefined
): Promise<WorkspaceChangeSummary> {
  if (!workspacePath) return unknownWorkspaceChangeSummary("workspace was not prepared");
  if (!workspaceBefore) return unknownWorkspaceChangeSummary("workspace before snapshot was not available");
  try {
    return diffWorkspaceSnapshots(workspaceBefore, await snapshotWorkspaceFiles(workspacePath));
  } catch (error) {
    return unknownWorkspaceChangeSummary(errorMessage(error));
  }
}

function cliExitCodeFor(policy: CliExitPolicy, status: ExternalCheckStatus): number {
  if (policy === "packet") return 0;
  return status === "passed" ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
