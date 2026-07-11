import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
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
  buildSetupPolicy,
  finalizePacketManifest,
  writeArtifacts,
  type ArtifactRecord
} from "./external-command-check-packet.js";
import {
  blockedCommandReports,
  blockedResult,
  cliExitCodeFor,
  defaultExternalCheckOutDir,
  finalStatus,
  firstSetupFailure,
  setupPhaseStatus
} from "./external-command-check-helpers.js";
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
const commandPolicy: CommandPolicy = { onFailure: "continue", finalStatusRule: "failed_if_any_command_failed_or_timed_out" };

export async function runExternalCommandCheck(options: ExternalCommandCheckOptions): Promise<ExternalCommandCheckResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const repoPath = resolve(options.repo);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxLogBytes = options.maxLogBytes ?? defaultMaxLogBytes;
  const cliExitPolicy = options.exitPolicy ?? "packet";
  const setupPolicy = buildSetupPolicy(options);
  const packetDir = join(resolve(options.out ?? defaultExternalCheckOutDir()), "packet");
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

  emit("task_received", {
    taskType: "external_command_check",
    setupCommandsRequested: options.setupCommands?.length ?? 0,
    commandsRequested: options.commands.length,
    setupPolicy
  });
  emit("run_created", { packetDir, cliExitPolicy, setupPolicy });
  emit("route_selected", { route: "external_command_check" });

  await assertDirectory(repoPath, "--repo");
  const originalBefore = await gitSnapshot(repoPath);
  const setupCommands = options.setupCommands ?? [];
  const blockedCommands = [
    ...blockedCommandReports(setupCommands, "setup"),
    ...blockedCommandReports(options.commands, "main")
  ];
  let workspacePath: string | undefined;
  const setupResults: CommandResult[] = [];
  const commandResults: CommandResult[] = [];
  let status: ExternalCheckStatus = "passed";
  let workspaceBefore: WorkspaceFileSnapshot | undefined;

  if (blockedCommands.length > 0) {
    status = "blocked";
    for (const blocked of blockedCommands) {
      const result = blockedResult(blocked, repoPath, runId);
      await writeFile(join(packetDir, result.stdoutPath), "", "utf8");
      await writeFile(join(packetDir, result.stderrPath), `${blocked.reason}\n`, "utf8");
      if (result.phase === "setup") setupResults.push(result);
      else commandResults.push(result);
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
    if (setupCommands.length > 0) {
      emit("setup_started", { parentEventId: workerStartedEventId, workerId, commandsRequested: setupCommands.length });
      for (let i = 0; i < setupCommands.length; i += 1) {
        const index = i + 1;
        const command = setupCommands[i]!;
        const commandId = `${runId}:setup:${String(index).padStart(3, "0")}`;
        emit("command_started", { parentEventId: workerStartedEventId, workerId, commandId, phase: "setup", index, command });
        const result = await runOneCommand({ commandId, phase: "setup", index, command, cwd: workspacePath, timeoutMs, maxLogBytes, logsDir });
        setupResults.push(result);
        await markArtifact(result.stdoutPath, "log");
        await markArtifact(result.stderrPath, "log");
        emit("command_finished", {
          parentEventId: workerStartedEventId,
          workerId,
          commandId,
          phase: "setup",
          index,
          command,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs
        });
        if (result.status !== "passed") break;
      }
      emit("setup_finished", {
        parentEventId: workerStartedEventId,
        workerId,
        status: setupPhaseStatus(setupResults),
        commandsRun: setupResults.length
      });
    }
    const setupFailure = firstSetupFailure(setupResults);
    if (setupFailure && !setupPolicy.continueAfterSetupFailure) {
      emit("setup_skipped_main_commands", {
        parentEventId: workerStartedEventId,
        workerId,
        reason: setupFailure.status,
        commandsSkipped: options.commands.length
      });
    } else {
      if (setupFailure) {
        emit("setup_diagnostic_main_commands_started", {
          parentEventId: workerStartedEventId,
          workerId,
          reason: setupFailure.status,
          commandsRequested: options.commands.length,
          caution: "main commands are diagnostic because setup/preflight failed"
        });
      }
      for (let i = 0; i < options.commands.length; i += 1) {
        const index = i + 1;
        const command = options.commands[i]!;
        const commandId = `${runId}:command:${String(index).padStart(3, "0")}`;
        emit("command_started", { parentEventId: workerStartedEventId, workerId, commandId, phase: "main", index, command });
        const result = await runOneCommand({ commandId, phase: "main", index, command, cwd: workspacePath, timeoutMs, maxLogBytes, logsDir });
        commandResults.push(result);
        await markArtifact(result.stdoutPath, "log");
        await markArtifact(result.stderrPath, "log");
        emit("command_finished", {
        parentEventId: workerStartedEventId,
        workerId,
        commandId,
        phase: "main",
        index,
        command,
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs
        });
      }
    }
    emit("worker_finished", { parentEventId: workerStartedEventId, workerId, worker: "command_runner" });
  }

  const safetyStartedEventId = emit("safety_check_started", { safetyStatus: "started" });
  const originalAfter = await gitSnapshot(repoPath);
  const mutationVerdict = mutationVerdictFor(originalBefore, originalAfter);
  const workspaceChangeSummary = await computeWorkspaceChangeSummary(workspacePath, workspaceBefore);
  status = finalStatus(status, setupResults, commandResults, mutationVerdict, setupPolicy.continueAfterSetupFailure);
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
    setupCommandsRequested: setupCommands.length,
    mainCommandsRequested: options.commands.length,
    originalBefore,
    originalAfter,
    mutationVerdict,
    workspacePath,
    workspaceChangeSummary,
    cliExitPolicy,
    cliExitCode,
    commandPolicy,
    setupPolicy,
    setupResults,
    commandResults,
    safetyReport,
    markArtifact
  });
  emit("summary_written", { artifactPath: "summary.md" });
  emit("run_finished", { status });
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await finalizePacketManifest(packetDir, externalCheckSchemaVersion);

  return { runId, status, packetDir, repoPath, workspacePath, cliExitPolicy, cliExitCode, setupResults, commandResults, safetyReport };
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
    "Setup:",
    ...(result.setupResults.length > 0
      ? result.setupResults.map((command) => `${command.index}. ${command.command} - ${command.status}`)
      : ["No setup commands requested."]),
    "",
    "Commands:",
    ...(result.commandResults.length > 0
      ? result.commandResults.map((command) => `${command.index}. ${command.command} - ${command.status}`)
      : ["Main commands skipped or not run."]),
    "",
    `Original repo: ${result.safetyReport.originalRepoMutationVerdict}`,
    "",
    "Key artifacts:",
    "- summary.md",
    "- setup-results.json",
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
  if (options.setupCommands?.some((command) => command.trim().length === 0)) throw new Error("--setup-command values must be non-empty.");
  if (options.commands.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("--timeout-ms must be a positive integer.");
  if (options.maxLogBytes !== undefined && (!Number.isInteger(options.maxLogBytes) || options.maxLogBytes <= 0)) throw new Error("--max-log-bytes must be a positive integer.");
  if (options.exitPolicy !== undefined && !["packet", "command-status"].includes(options.exitPolicy)) {
    throw new Error("--exit-policy must be packet or command-status.");
  }
  if (options.setupNetworkIntent !== undefined && !["none", "expected", "unknown"].includes(options.setupNetworkIntent)) {
    throw new Error("--setup-network-intent must be none, expected, or unknown.");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
