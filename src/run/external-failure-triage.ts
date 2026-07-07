import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, writeJson, writeText } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import { runExternalCommandCheck } from "./external-command-check.js";
import { artifactTypeFor, writePacketManifest, type ArtifactRecord } from "./external-command-check-packet.js";
import type { CommandResult } from "./external-command-check-types.js";
import { analyzeFailure } from "./external-failure-triage-classifier.js";
import { renderEvidence, renderFailureTriage, renderHumanReview, renderSummary } from "./external-failure-triage-renderer.js";
import {
  externalFailureTriageSchemaVersion,
  type ExternalFailureTriageSourceRun,
  type ExternalFailureTriageOptions,
  type ExternalFailureTriageResult,
  type FailureEvidence,
  type FailureTriageStatus
} from "./external-failure-triage-types.js";

export type { ExternalFailureTriageOptions, ExternalFailureTriageResult } from "./external-failure-triage-types.js";

const excerptBytes = 4000;

export async function runExternalFailureTriage(options: ExternalFailureTriageOptions): Promise<ExternalFailureTriageResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const outRoot = resolve(options.out ?? defaultOutDir());
  const packetDir = join(outRoot, "packet");
  await ensureDir(packetDir);

  const events: Array<Record<string, unknown>> = [];
  const artifactRecords = new Map<string, ArtifactRecord>();
  let eventCounter = 0;
  const emit = (type: string, data: object = {}) => {
    eventCounter += 1;
    const event = {
      schemaVersion: externalFailureTriageSchemaVersion,
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
    taskType: "external_failure_triage",
    inputMode: options.fromCheckPacket ? "from_check_packet" : "repo_command"
  });
  emit("route_selected", { route: "external_failure_triage" });

  const sourceCheckPacket = options.fromCheckPacket
    ? resolve(options.fromCheckPacket)
    : await createSourceCheckPacket(options, outRoot, emit);
  emit("source_packet_selected", { sourceCheckPacket });

  const sourceRun = await readSourceRun(sourceCheckPacket);
  const commandResults = await readCommandResults(sourceCheckPacket, sourceRun);
  const evidence = await collectEvidence(sourceCheckPacket, commandResults);
  const analysis = analyzeFailure(sourceRun, evidence);
  const status: FailureTriageStatus = analysis.category === "no_failure_observed"
    ? "no_failure_observed"
    : analysis.requiresMoreContext
      ? "needs_more_context"
      : "triaged";
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);

  const rootCause = {
    schemaVersion: externalFailureTriageSchemaVersion,
    runId,
    sourceCheckPacket,
    sourceCheckRunId: sourceRun.runId ?? null,
    sourceCheckStatus: sourceRun.status ?? "unknown",
    setupPolicy: sourceRun.setupPolicy ?? null,
    category: analysis.category,
    confidence: analysis.confidence,
    probableRootCause: analysis.probableRootCause,
    evidenceBasis: analysis.evidenceBasis,
    requiresMoreContext: analysis.requiresMoreContext,
    readyForCodeProposal: analysis.readyForCodeProposal,
    safeNextAction: analysis.safeNextAction,
    commands: evidence.map((item) => ({
      commandId: item.commandId,
      phase: item.phase,
      index: item.index,
      command: item.command,
      status: item.status,
      exitCode: item.exitCode,
      timedOut: item.timedOut,
      stdoutPath: item.stdoutPath,
      stderrPath: item.stderrPath,
      stdoutTruncated: item.stdoutTruncated,
      stderrTruncated: item.stderrTruncated
    }))
  };

  await writeText(join(packetDir, "summary.md"), renderSummary({ runId, status, sourceRun, sourceCheckPacket, analysis, evidence }));
  await markArtifact("summary.md");
  await writeText(join(packetDir, "human-review.md"), renderHumanReview({ sourceRun, analysis }));
  await markArtifact("human-review.md");
  await writeText(join(packetDir, "failure-triage.md"), renderFailureTriage({ sourceCheckPacket, sourceRun, analysis, evidence }));
  await markArtifact("failure-triage.md");
  await writeJson(join(packetDir, "root-cause.json"), rootCause);
  await markArtifact("root-cause.json");
  await writeText(join(packetDir, "evidence-excerpts.md"), renderEvidence(evidence));
  await markArtifact("evidence-excerpts.md");
  await writeText(join(packetDir, "safe-next-action.md"), `${analysis.safeNextAction}\n`);
  await markArtifact("safe-next-action.md");
  await writeJson(join(packetDir, "run.json"), {
    schemaVersion: externalFailureTriageSchemaVersion,
    runId,
    taskType: "external_failure_triage",
    status,
    startedAt,
    finishedAt,
    durationMs,
    sourceCheckPacket,
    sourceCheckRunId: sourceRun.runId ?? null,
    sourceCheckStatus: sourceRun.status ?? "unknown",
    setupPolicy: sourceRun.setupPolicy ?? null,
    category: analysis.category,
    confidence: analysis.confidence,
    requiresMoreContext: analysis.requiresMoreContext,
    readyForCodeProposal: analysis.readyForCodeProposal,
    artifactDir: packetDir
  });
  await markArtifact("run.json");
  await writeJson(join(packetDir, "metrics.json"), {
    schemaVersion: externalFailureTriageSchemaVersion,
    runId,
    durationMs,
    commandsAnalyzed: evidence.length,
    failedCommands: evidence.filter((item) => item.status === "failed").length,
    timedOutCommands: evidence.filter((item) => item.status === "timed_out").length,
    errorCommands: evidence.filter((item) => item.status === "error").length,
    truncatedLogsReferenced: evidence.filter((item) => item.stdoutTruncated || item.stderrTruncated).length,
    category: analysis.category,
    confidence: analysis.confidence,
    sourceCheckStatus: sourceRun.status ?? "unknown",
    setupPolicy: sourceRun.setupPolicy ?? null,
    finalStatus: status,
    humanGateRequired: true
  });
  await markArtifact("metrics.json");
  await writeJson(join(packetDir, "safety-report.json"), {
    schemaVersion: externalFailureTriageSchemaVersion,
    runId,
    sourceCheckPacket,
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    originalRepoMutationAllowed: false,
    readOnlyPacketAnalysis: Boolean(options.fromCheckPacket),
    commandExecutionMode: options.fromCheckPacket ? "none" : "external_check_disposable_workspace",
    note: "Failure triage reads an existing check packet or creates one through external check. It does not modify the original repository."
  });
  await markArtifact("safety-report.json");
  await writeJson(join(packetDir, "trajectory.json"), {
    schemaVersion: externalFailureTriageSchemaVersion,
    runId,
    taskType: "external_failure_triage",
    steps: [
      { type: "route_selected", route: "external_failure_triage" },
      { type: "source_packet_selected", status: "finished" },
      { type: "evidence_extracted", status: "finished", commandsAnalyzed: evidence.length },
      { type: "failure_classified", status: "finished", category: analysis.category, confidence: analysis.confidence },
      { type: "summary", status: "written" }
    ]
  });
  await markArtifact("trajectory.json");
  emit("run_finished", { status, category: analysis.category, confidence: analysis.confidence });
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await markArtifact("events.jsonl");
  await writePacketManifest(packetDir, artifactRecords);
  await markArtifact("packet-manifest.json");
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  return {
    runId,
    status,
    category: analysis.category,
    confidence: analysis.confidence,
    packetDir,
    sourceCheckPacket,
    sourceCheckStatus: sourceRun.status ?? "unknown",
    readyForCodeProposal: analysis.readyForCodeProposal,
    requiresMoreContext: analysis.requiresMoreContext,
    safeNextAction: analysis.safeNextAction
  };
}

export function renderExternalFailureTriageCliSummary(result: ExternalFailureTriageResult): string {
  return [
    "RunForge external failure triage",
    "",
    `Run ID: ${result.runId}`,
    `Status: ${result.status}`,
    `Category: ${result.category}`,
    `Confidence: ${result.confidence}`,
    `Source check status: ${result.sourceCheckStatus}`,
    `Source check packet: ${result.sourceCheckPacket}`,
    `Packet: ${result.packetDir}`,
    "",
    `Ready for code proposal: ${result.readyForCodeProposal}`,
    `Requires more context: ${result.requiresMoreContext}`,
    `Safe next action: ${result.safeNextAction}`,
    "",
    "Key artifacts:",
    "- summary.md",
    "- failure-triage.md",
    "- root-cause.json",
    "- evidence-excerpts.md",
    "- safe-next-action.md"
  ].join("\n");
}

function validateOptions(options: ExternalFailureTriageOptions): void {
  const hasPacket = Boolean(options.fromCheckPacket);
  const hasRepoCommand = Boolean(options.repo) || Boolean(options.commands && options.commands.length > 0);
  if (hasPacket && hasRepoCommand) throw new Error("Use either --from-check-packet or --repo with --command, not both.");
  if (!hasPacket && !options.repo) throw new Error("--repo is required when --from-check-packet is not provided.");
  if (!hasPacket && (!options.commands || options.commands.length === 0)) {
    throw new Error("At least one --command is required when --from-check-packet is not provided.");
  }
  if (options.setupCommands?.some((command) => command.trim().length === 0)) throw new Error("--setup-command values must be non-empty.");
  if (options.commands?.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
}

async function createSourceCheckPacket(
  options: ExternalFailureTriageOptions,
  outRoot: string,
  emit: (type: string, data?: object) => string
): Promise<string> {
  const checkOut = join(outRoot, "check-source");
  emit("source_check_started", { checkOut });
  const result = await runExternalCommandCheck({
    repo: options.repo!,
    setupCommands: options.setupCommands,
    setupNetworkIntent: options.setupNetworkIntent,
    continueAfterSetupFailure: options.continueAfterSetupFailure,
    commands: options.commands!,
    out: checkOut,
    timeoutMs: options.timeoutMs,
    maxLogBytes: options.maxLogBytes,
    exitPolicy: "packet"
  });
  emit("source_check_finished", { checkOut, sourceCheckPacket: result.packetDir, sourceCheckStatus: result.status });
  return result.packetDir;
}

async function readSourceRun(packetDir: string): Promise<ExternalFailureTriageSourceRun> {
  await access(join(packetDir, "run.json"));
  const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as ExternalFailureTriageSourceRun;
  return run;
}

async function readCommandResults(packetDir: string, sourceRun: ExternalFailureTriageSourceRun): Promise<CommandResult[]> {
  const setupResults = await readSetupResults(packetDir);
  try {
    const results = JSON.parse(await readFile(join(packetDir, "command-results.json"), "utf8")) as { commands?: CommandResult[] };
    if (Array.isArray(results.commands)) return [...setupResults, ...results.commands];
  } catch {
    // Fall back to run.json below.
  }
  return [...setupResults, ...(Array.isArray(sourceRun.commands) ? sourceRun.commands : [])];
}

async function readSetupResults(packetDir: string): Promise<CommandResult[]> {
  try {
    const results = JSON.parse(await readFile(join(packetDir, "setup-results.json"), "utf8")) as { commands?: CommandResult[] };
    return Array.isArray(results.commands) ? results.commands : [];
  } catch {
    return [];
  }
}

async function collectEvidence(packetDir: string, commandResults: CommandResult[]): Promise<FailureEvidence[]> {
  const interesting = commandResults.filter((result) => result.status !== "passed");
  const selected = interesting.length > 0 ? interesting : commandResults;
  return Promise.all(selected.map(async (result) => ({
    commandId: result.commandId,
    phase: result.phase,
    index: result.index,
    command: result.command,
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    stdoutExcerpt: await readExcerpt(join(packetDir, result.stdoutPath)),
    stderrExcerpt: await readExcerpt(join(packetDir, result.stderrPath)),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  })));
}

async function readExcerpt(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") <= excerptBytes) return text.trimEnd();
    return `${text.slice(0, Math.floor(excerptBytes / 2)).trimEnd()}\n\n[... excerpt truncated ...]\n\n${text.slice(-Math.floor(excerptBytes / 2)).trimStart()}`;
  } catch (error) {
    return `[log unavailable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function defaultOutDir(): string {
  return join(process.cwd(), "artifacts", "external-failure-triage");
}
