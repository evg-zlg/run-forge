import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { writeJson, writeText } from "../core/artifact-store.js";
import { buildMetrics, renderSummary } from "./external-command-check-renderer.js";
import type { WorkspaceChangeSummary } from "./external-command-check-git.js";
import type {
  CliExitPolicy,
  CommandPolicy,
  CommandResult,
  ExternalCheckStatus,
  ExternalCommandCheckOptions,
  SafetyReport,
  SetupPolicy
} from "./external-command-check-types.js";
import { externalCheckSchemaVersion } from "./external-command-check-types.js";

export interface ArtifactRecord {
  artifactId: string;
  artifactPath: string;
  artifactType: string;
  artifactBytes: number;
  hash: string;
  createdAt: string;
}

export function artifactTypeFor(path: string): string {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".jsonl")) return "jsonl";
  if (path.endsWith(".md")) return "summary";
  if (path.endsWith(".log")) return "log";
  return "artifact";
}

export function buildSafetyReport(input: {
  options: ExternalCommandCheckOptions;
  runId: string;
  cliExitPolicy: CliExitPolicy;
  cliExitCode: number;
  originalBefore: SafetyReport["originalRepoBefore"];
  originalAfter: SafetyReport["originalRepoAfter"];
  mutationVerdict: SafetyReport["originalRepoMutationVerdict"];
  workspacePath?: string;
  blockedCommands: Array<{ index: number; command: string; reason: string }>;
}): SafetyReport {
  const setupPolicy = buildSetupPolicy(input.options);
  return {
    schemaVersion: externalCheckSchemaVersion,
    runId: input.runId,
    cliExitPolicy: input.cliExitPolicy,
    cliExitCode: input.cliExitCode,
    originalRepoMutationAllowed: false,
    originalRepoBefore: input.originalBefore,
    originalRepoAfter: input.originalAfter,
    originalRepoMutationVerdict: input.mutationVerdict,
    workspacePath: input.workspacePath,
    noPushAttempted: !allUserCommands(input.options).some((command) => /\bgit\s+push\b/.test(command)),
    noMergeAttempted: !allUserCommands(input.options).some((command) => /\bgit\s+merge\b/.test(command)),
    noApplyToOriginalRepoAttempted: true,
    noDeployAttempted: !allUserCommands(input.options).some((command) => /\bdeploy\b/.test(command)),
    commandsUserProvidedViaCli: true,
    setupCommandsUserProvided: (input.options.setupCommands?.length ?? 0) > 0,
    setupMayUseNetwork: setupMayUseNetwork(input.options.setupCommands ?? []),
    setupPolicy,
    setupNetworkIntentEnforced: false,
    setupPolicyNotes: [
      "Setup commands are user-provided and run only in the disposable workspace.",
      `Setup network intent was declared as ${setupPolicy.networkIntent}; RunForge records this intent but does not enforce network blocking.`,
      "RunForge never applies setup or command side effects to the original repository."
    ],
    secretsHandling: {
      deliberateSecretPrinting: false,
      note: "RunForge captures user-provided command stdout/stderr as evidence and does not deliberately print or expand secrets."
    },
    dependencyContext: {
      workspacePolicy: "disposable_copy",
      note: "Dependency directories such as node_modules are not copied by default; commands that require installed dependencies should include setup steps or run in a workspace policy that supplies them."
    },
    blockedCommands: input.blockedCommands
  };
}

export async function writePacketManifest(packetDir: string, artifactRecords: Map<string, ArtifactRecord>): Promise<void> {
  await writeJson(join(packetDir, "packet-manifest.json"), {
    schemaVersion: externalCheckSchemaVersion,
    artifacts: [...artifactRecords.values()]
      .sort((left, right) => left.artifactPath.localeCompare(right.artifactPath))
      .map((artifact) => ({
        path: artifact.artifactPath,
        type: artifact.artifactType,
        sizeBytes: artifact.artifactBytes,
        hash: artifact.hash,
        createdAt: artifact.createdAt
      }))
  });
}

/** Compute the manifest from final on-disk bytes. The manifest excludes itself. */
export async function finalizePacketManifest(packetDir: string, schemaVersion: string): Promise<void> {
  const files = (await packetFiles(packetDir))
    .map((path) => relative(packetDir, path))
    .filter((path) => path !== "packet-manifest.json")
    .sort();
  const artifacts = await Promise.all(files.map(async (path) => {
    const fullPath = join(packetDir, path);
    const bytes = await readFile(fullPath);
    const info = await stat(fullPath);
    return {
      path,
      type: artifactTypeFor(path),
      sizeBytes: info.size,
      hash: createHash("sha256").update(bytes).digest("hex"),
      createdAt: info.mtime.toISOString()
    };
  }));
  await writeJson(join(packetDir, "packet-manifest.json"), { schemaVersion, artifacts });
}

async function packetFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return packetFiles(path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

export async function writeArtifacts(input: {
  packetDir: string;
  runId: string;
  schemaVersion: string;
  status: ExternalCheckStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  repoPath: string;
  timeoutMs: number;
  maxLogBytes: number;
  setupCommandsRequested: number;
  mainCommandsRequested: number;
  originalBefore: SafetyReport["originalRepoBefore"];
  originalAfter: SafetyReport["originalRepoAfter"];
  mutationVerdict: SafetyReport["originalRepoMutationVerdict"];
  workspacePath?: string;
  workspaceChangeSummary: WorkspaceChangeSummary;
  cliExitPolicy: CliExitPolicy;
  cliExitCode: number;
  commandPolicy: CommandPolicy;
  setupPolicy: SetupPolicy;
  setupResults: CommandResult[];
  commandResults: CommandResult[];
  safetyReport: SafetyReport;
  markArtifact: (path: string, artifactType?: string) => Promise<void>;
}) {
  await writeJson(join(input.packetDir, "setup-results.json"), {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    commands: input.setupResults
  });
  await input.markArtifact("setup-results.json");
  await writeJson(join(input.packetDir, "command-results.json"), {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    commandPolicy: input.commandPolicy,
    commands: input.commandResults
  });
  await input.markArtifact("command-results.json");
  await writeJson(join(input.packetDir, "safety-report.json"), input.safetyReport);
  await input.markArtifact("safety-report.json");
  await writeJson(join(input.packetDir, "metrics.json"), buildMetrics(input));
  await input.markArtifact("metrics.json");
  await writeJson(join(input.packetDir, "trajectory.json"), buildTrajectory(input));
  await input.markArtifact("trajectory.json");
  await writeJson(join(input.packetDir, "run.json"), buildRunJson(input));
  await input.markArtifact("run.json");
  await writeText(join(input.packetDir, "summary.md"), renderSummary(input));
  await input.markArtifact("summary.md");
}

function buildRunJson(input: Parameters<typeof writeArtifacts>[0]) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    taskType: "external_command_check",
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    cliExitPolicy: input.cliExitPolicy,
    cliExitCode: input.cliExitCode,
    commandPolicy: input.commandPolicy,
    setupPolicy: input.setupPolicy,
    repo: {
      path: input.repoPath,
      headBefore: input.originalBefore.head,
      headAfter: input.originalAfter.head,
      statusBefore: input.originalBefore.status,
      statusAfter: input.originalAfter.status,
      baselineDirty: input.originalBefore.status === null ? null : input.originalBefore.status.length > 0,
      mutationVerdict: input.mutationVerdict
    },
    workspace: { path: input.workspacePath, changeSummary: input.workspaceChangeSummary },
    requested: { setupCommands: input.setupCommandsRequested, commands: input.mainCommandsRequested },
    commands: input.commandResults.map(commandResultJson),
    setupCommands: input.setupResults.map(commandResultJson),
    artifactDir: input.packetDir,
    defaults: { timeoutMs: input.timeoutMs, maxLogBytes: input.maxLogBytes }
  };
}

function buildTrajectory(input: Parameters<typeof writeArtifacts>[0]) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    taskType: "external_command_check",
    setupPolicy: input.setupPolicy,
    commandPolicy: input.commandPolicy,
    steps: [
      { type: "route_selected", route: "external_command_check" },
      { type: "workspace_prepared", status: input.workspacePath ? "finished" : "skipped" },
      { type: "setup", status: input.setupResults.length > 0 ? setupStepStatus(input.status) : "skipped", commands: input.setupResults.length },
      { type: "worker", worker: "command_runner", status: input.status === "blocked" ? "blocked" : mainStepStatus(input.status) },
      { type: "safety_check", status: "finished" },
      { type: "summary", status: "written" }
    ]
  };
}

function commandResultJson(result: CommandResult) {
  return {
    commandId: result.commandId,
    phase: result.phase,
    index: result.index,
    command: result.command,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  };
}

function allUserCommands(options: ExternalCommandCheckOptions): string[] {
  return [...(options.setupCommands ?? []), ...options.commands];
}

export function buildSetupPolicy(options: ExternalCommandCheckOptions): SetupPolicy {
  return {
    setupCommandsProvided: (options.setupCommands?.length ?? 0) > 0,
    networkIntent: options.setupNetworkIntent ?? "unknown",
    continueAfterSetupFailure: Boolean(options.continueAfterSetupFailure),
    mainCommandsSkippedOnSetupFailure: !options.continueAfterSetupFailure
  };
}

function setupMayUseNetwork(setupCommands: string[]): "unknown" | "yes" | "no" {
  if (setupCommands.length === 0) return "no";
  return setupCommands.some((command) => /\b(install|add|update|fetch|curl|wget|corepack|npx|pnpm|npm|yarn|bun)\b/i.test(command))
    ? "yes"
    : "unknown";
}

function setupStepStatus(status: ExternalCheckStatus): string {
  if (status === "setup_failed" || status === "setup_timed_out" || status === "setup_error" || status.startsWith("setup_failed_main_")) return status;
  return "setup_passed";
}

function mainStepStatus(status: ExternalCheckStatus): string {
  if (status === "setup_failed" || status === "setup_timed_out" || status === "setup_error") return "skipped";
  return "finished";
}
