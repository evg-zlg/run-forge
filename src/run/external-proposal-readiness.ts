import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, writeJson, writeText } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import { runExternalFailureTriage } from "./external-failure-triage.js";
import type { FailureTriageCategory, FailureTriageConfidence } from "./external-failure-triage-types.js";
import { artifactTypeFor, writePacketManifest, type ArtifactRecord } from "./external-command-check-packet.js";
import {
  renderExternalProposalReadinessCliSummary,
  renderMissingContext,
  renderProposalReadiness,
  renderReadinessHumanReview,
  renderReadinessSummary
} from "./external-proposal-readiness-renderer.js";
import { buildProposalContract } from "./external-proposal-readiness-contract.js";

export const externalProposalReadinessSchemaVersion = "alpha-3b";

export type ProposalReadinessOutcome =
  | "ready_for_code_proposal"
  | "needs_more_context"
  | "research_only"
  | "blocked_by_safety"
  | "no_failure_observed";

export interface ExternalProposalReadinessOptions {
  fromTriagePacket?: string;
  repo?: string;
  commands?: string[];
  out?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  runId?: string;
}

export interface ExternalProposalReadinessResult {
  runId: string;
  readinessOutcome: ProposalReadinessOutcome;
  canAttemptCodeProposal: boolean;
  packetDir: string;
  sourceTriagePacket: string;
  failureCategory: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  recommendedNextAction: string;
}

export interface TriageRootCause {
  sourceCheckPacket?: string;
  category?: FailureTriageCategory;
  confidence?: FailureTriageConfidence;
  requiresMoreContext?: boolean;
  readyForCodeProposal?: boolean;
  safeNextAction?: string;
  evidenceBasis?: string[];
}

interface TriageRun {
  status?: string;
  sourceCheckStatus?: string;
  category?: FailureTriageCategory;
  confidence?: FailureTriageConfidence;
}

interface TriageSafetyReport {
  blockedCommands?: Array<{ reason?: string }>;
  originalRepoMutationVerdict?: string;
  noPushAttempted?: boolean;
  noMergeAttempted?: boolean;
  noDeployAttempted?: boolean;
  noApplyToOriginalRepoAttempted?: boolean;
}

export async function runExternalProposalReadiness(options: ExternalProposalReadinessOptions): Promise<ExternalProposalReadinessResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const outRoot = resolve(options.out ?? defaultOutDir());
  const packetDir = join(outRoot, "packet");
  await ensureDir(packetDir);

  const events: Array<Record<string, unknown>> = [];
  const artifacts = new Map<string, ArtifactRecord>();
  let eventCounter = 0;
  const emit = (type: string, data: object = {}) => {
    eventCounter += 1;
    const event = {
      schemaVersion: externalProposalReadinessSchemaVersion,
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
    artifacts.set(artifactPath, record);
    emit("artifact_written", record);
  };

  emit("task_received", {
    taskType: "external_proposal_readiness",
    inputMode: options.fromTriagePacket ? "from_triage_packet" : "repo_command"
  });
  emit("route_selected", { route: "external_proposal_readiness" });

  const sourceTriagePacket = options.fromTriagePacket
    ? resolve(options.fromTriagePacket)
    : await createSourceTriagePacket(options, outRoot, emit);
  emit("source_packet_selected", { sourceTriagePacket });

  const rootCause = await readRootCause(sourceTriagePacket);
  const triageRun = await readOptionalJson<TriageRun>(join(sourceTriagePacket, "run.json"));
  const triageSafety = await readOptionalJson<TriageSafetyReport>(join(sourceTriagePacket, "safety-report.json"));
  const decision = decideReadiness(rootCause, triageRun, triageSafety);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);

  const contract = buildProposalContract({ runId, sourceTriagePacket, rootCause, decision });
  await writeText(join(packetDir, "summary.md"), renderReadinessSummary({ runId, decision, rootCause, sourceTriagePacket }));
  await markArtifact("summary.md");
  await writeText(join(packetDir, "human-review.md"), renderReadinessHumanReview(decision));
  await markArtifact("human-review.md");
  await writeText(join(packetDir, "proposal-readiness.md"), renderProposalReadiness({ decision, rootCause, sourceTriagePacket }));
  await markArtifact("proposal-readiness.md");
  await writeJson(join(packetDir, "proposal-contract.json"), contract);
  await markArtifact("proposal-contract.json");
  await writeText(join(packetDir, "missing-context.md"), renderMissingContext(decision));
  await markArtifact("missing-context.md");
  await writeText(join(packetDir, "recommended-next-action.md"), `${decision.recommendedNextAction}\n`);
  await markArtifact("recommended-next-action.md");
  await writeJson(join(packetDir, "run.json"), {
    schemaVersion: externalProposalReadinessSchemaVersion,
    runId,
    taskType: "external_proposal_readiness",
    status: decision.readinessOutcome,
    startedAt,
    finishedAt,
    durationMs,
    sourceTriagePacket,
    sourceCheckPacket: rootCause.sourceCheckPacket ?? null,
    failureCategory: decision.failureCategory,
    confidence: decision.confidence,
    canAttemptCodeProposal: decision.canAttemptCodeProposal,
    artifactDir: packetDir
  });
  await markArtifact("run.json");
  await writeJson(join(packetDir, "metrics.json"), {
    schemaVersion: externalProposalReadinessSchemaVersion,
    runId,
    durationMs,
    readinessOutcome: decision.readinessOutcome,
    canAttemptCodeProposal: decision.canAttemptCodeProposal,
    failureCategory: decision.failureCategory,
    confidence: decision.confidence,
    missingContextCount: decision.missingContext.length,
    humanGateRequired: true
  });
  await markArtifact("metrics.json");
  await writeJson(join(packetDir, "safety-report.json"), {
    schemaVersion: externalProposalReadinessSchemaVersion,
    runId,
    sourceTriagePacket,
    originalRepoMutationAllowed: false,
    commandExecutionMode: options.fromTriagePacket ? "none" : "external_failure_triage_via_disposable_workspace",
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    blockedBySafety: decision.readinessOutcome === "blocked_by_safety",
    note: "Proposal readiness reads triage evidence and emits a contract. It does not create or apply patches."
  });
  await markArtifact("safety-report.json");
  await writeJson(join(packetDir, "trajectory.json"), {
    schemaVersion: externalProposalReadinessSchemaVersion,
    runId,
    taskType: "external_proposal_readiness",
    steps: [
      { type: "route_selected", route: "external_proposal_readiness" },
      { type: "source_packet_selected", status: "finished" },
      { type: "triage_contract_loaded", status: "finished" },
      { type: "readiness_decided", status: "finished", outcome: decision.readinessOutcome },
      { type: "summary", status: "written" }
    ]
  });
  await markArtifact("trajectory.json");
  emit("run_finished", { status: decision.readinessOutcome, canAttemptCodeProposal: decision.canAttemptCodeProposal });
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await markArtifact("events.jsonl");
  await writePacketManifest(packetDir, artifacts);
  await markArtifact("packet-manifest.json");
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  return {
    runId,
    readinessOutcome: decision.readinessOutcome,
    canAttemptCodeProposal: decision.canAttemptCodeProposal,
    packetDir,
    sourceTriagePacket,
    failureCategory: decision.failureCategory,
    confidence: decision.confidence,
    recommendedNextAction: decision.recommendedNextAction
  };
}

export { renderExternalProposalReadinessCliSummary };

function validateOptions(options: ExternalProposalReadinessOptions): void {
  const hasPacket = Boolean(options.fromTriagePacket);
  const hasRepoCommand = Boolean(options.repo) || Boolean(options.commands && options.commands.length > 0);
  if (hasPacket && hasRepoCommand) throw new Error("Use either --from-triage-packet or --repo with --command, not both.");
  if (!hasPacket && !options.repo) throw new Error("--repo is required when --from-triage-packet is not provided.");
  if (!hasPacket && (!options.commands || options.commands.length === 0)) {
    throw new Error("At least one --command is required when --from-triage-packet is not provided.");
  }
  if (options.commands?.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
}

async function createSourceTriagePacket(
  options: ExternalProposalReadinessOptions,
  outRoot: string,
  emit: (type: string, data?: object) => string
): Promise<string> {
  const triageOut = join(outRoot, "triage-source");
  emit("source_triage_started", { triageOut });
  const result = await runExternalFailureTriage({
    repo: options.repo,
    commands: options.commands,
    out: triageOut,
    timeoutMs: options.timeoutMs,
    maxLogBytes: options.maxLogBytes
  });
  emit("source_triage_finished", { triageOut, sourceTriagePacket: result.packetDir, sourceTriageStatus: result.status });
  return result.packetDir;
}

async function readRootCause(packetDir: string): Promise<TriageRootCause> {
  await access(join(packetDir, "root-cause.json"));
  return JSON.parse(await readFile(join(packetDir, "root-cause.json"), "utf8")) as TriageRootCause;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface ReadinessDecision {
  readinessOutcome: ProposalReadinessOutcome;
  canAttemptCodeProposal: boolean;
  failureCategory: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  missingContext: string[];
  recommendedNextAction: string;
}

function decideReadiness(rootCause: TriageRootCause, triageRun: TriageRun | null, safety: TriageSafetyReport | null): ReadinessDecision {
  const failureCategory = rootCause.category ?? triageRun?.category ?? "unknown_failure";
  const confidence = rootCause.confidence ?? triageRun?.confidence ?? "low";
  if (hasSafetyBlocker(safety)) {
    return {
      readinessOutcome: "blocked_by_safety",
      canAttemptCodeProposal: false,
      failureCategory,
      confidence,
      missingContext: ["Safety report indicates a blocked command or original repository mutation risk."],
      recommendedNextAction: "Resolve the safety blocker before attempting any code proposal."
    };
  }
  if (failureCategory === "no_failure_observed" || triageRun?.status === "no_failure_observed") {
    return {
      readinessOutcome: "no_failure_observed",
      canAttemptCodeProposal: false,
      failureCategory: "no_failure_observed",
      confidence: "high",
      missingContext: [],
      recommendedNextAction: "No code proposal is needed because the source packet did not observe a failure."
    };
  }
  if (failureCategory === "timeout") {
    return {
      readinessOutcome: "research_only",
      canAttemptCodeProposal: false,
      failureCategory,
      confidence,
      missingContext: ["The timeout evidence does not identify a deterministic source edit."],
      recommendedNextAction: "Research the timeout with narrower commands or larger timeout limits before proposing code."
    };
  }
  if (failureCategory === "test_assertion_failure" || failureCategory === "typecheck_error" || failureCategory === "lint_error" || failureCategory === "build_error") {
    return {
      readinessOutcome: "ready_for_code_proposal",
      canAttemptCodeProposal: true,
      failureCategory,
      confidence: confidence === "low" ? "medium" : confidence,
      missingContext: [],
      recommendedNextAction: "Create a proposal patch in a disposable workspace and verify it there; human review remains required."
    };
  }
  return {
    readinessOutcome: "needs_more_context",
    canAttemptCodeProposal: false,
    failureCategory,
    confidence,
    missingContext: [`${failureCategory} is not deterministic enough for the current proposal engine.`],
    recommendedNextAction: rootCause.safeNextAction ?? "Collect more focused failure evidence before attempting a code proposal."
  };
}

function hasSafetyBlocker(safety: TriageSafetyReport | null): boolean {
  if (!safety) return false;
  if ((safety.blockedCommands?.length ?? 0) > 0) return true;
  if (safety.originalRepoMutationVerdict === "changed") return true;
  return safety.noPushAttempted === false || safety.noMergeAttempted === false || safety.noDeployAttempted === false || safety.noApplyToOriginalRepoAttempted === false;
}

function defaultOutDir(): string {
  return join(process.cwd(), "artifacts", "external-proposal-readiness");
}
