import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, writeJson, writeText } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import type { RunSpec } from "../core/types.js";
import { buildFixtureCodeProposal, type DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { validateCommandSafety } from "./command-safety.js";
import { gitSnapshot, mutationVerdictFor, prepareWorkspace } from "./external-command-check-git.js";
import { artifactTypeFor, writePacketManifest, type ArtifactRecord } from "./external-command-check-packet.js";
import type { CommandResult } from "./external-command-check-types.js";
import { runExternalProposalReadiness } from "./external-proposal-readiness.js";
import {
  renderCodeProposalSummary,
  renderExternalCodeProposalCliSummary,
  renderHumanReview,
  renderPatchSummary
} from "./external-code-proposal-renderer.js";
import { applyPatchInWorkspace, runVerificationCommands, verificationCommandsFor } from "./external-code-proposal-workspace.js";
export const externalCodeProposalSchemaVersion = "alpha-3c";

export type CodeProposalOutcome =
  | "proposal_ready_verified"
  | "proposal_ready_unverified"
  | "no_safe_proposal"
  | "not_ready"
  | "verification_failed"
  | "blocked_by_safety";

export interface ExternalCodeProposalOptions {
  fromReadinessPacket?: string;
  repo?: string;
  commands?: string[];
  out?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  runId?: string;
}

export interface ExternalCodeProposalResult {
  runId: string;
  outcome: CodeProposalOutcome;
  packetDir: string;
  sourceReadinessPacket: string;
  proposalPatchBytes: number;
  verificationPassed: boolean;
  originalRepoMutationVerdict: string;
}

interface ReadinessContract {
  readinessOutcome?: string;
  canAttemptCodeProposal?: boolean;
  sourceTriagePacket?: string;
  sourceCheckPacket?: string | null;
  failureCategory?: string;
  suggestedVerificationCommands?: string[];
}

interface CheckRun {
  repo?: { path?: string };
  commands?: CommandResult[];
}

export async function runExternalCodeProposal(options: ExternalCodeProposalOptions): Promise<ExternalCodeProposalResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const outRoot = resolve(options.out ?? defaultOutDir());
  const packetDir = join(outRoot, "packet");
  const logsDir = join(packetDir, "logs");
  await ensureDir(logsDir);

  const events: Array<Record<string, unknown>> = [];
  const artifacts = new Map<string, ArtifactRecord>();
  let eventCounter = 0;
  const emit = (type: string, data: object = {}) => {
    eventCounter += 1;
    const event = {
      schemaVersion: externalCodeProposalSchemaVersion,
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
    taskType: "external_code_proposal",
    inputMode: options.fromReadinessPacket ? "from_readiness_packet" : "repo_command"
  });
  emit("route_selected", { route: "external_code_proposal" });
  const sourceReadinessPacket = options.fromReadinessPacket
    ? resolve(options.fromReadinessPacket)
    : await createSourceReadinessPacket(options, outRoot, emit);
  emit("source_packet_selected", { sourceReadinessPacket });
  const contract = await readReadinessContract(sourceReadinessPacket);
  const sourceCheckPacket = contract.sourceCheckPacket ? resolve(contract.sourceCheckPacket) : undefined;
  const sourceCheckRun = sourceCheckPacket ? await readOptionalJson<CheckRun>(join(sourceCheckPacket, "run.json")) : null;
  const repoPath = sourceCheckRun?.repo?.path ? resolve(sourceCheckRun.repo.path) : options.repo ? resolve(options.repo) : undefined;
  const verificationCommands = verificationCommandsFor(contract, sourceCheckRun, options.commands);
  let workspacePath: string | undefined;
  let proposal: DeterministicCodeProposal | null = null;
  let applyStatus = "not_run";
  let verificationResults: CommandResult[] = [];
  let beforeResults = sourceCheckRun?.commands ?? [];
  let outcome: CodeProposalOutcome = "not_ready";
  let originalBefore = repoPath ? await gitSnapshot(repoPath) : null;
  let originalAfter = originalBefore;
  let originalRepoMutationVerdict = "unknown";
  const diagnostics: string[] = [];

  if (!contract.canAttemptCodeProposal) {
    outcome = "not_ready";
    diagnostics.push(`Readiness outcome is ${contract.readinessOutcome ?? "unknown"}; code proposal is not allowed.`);
  } else if (!repoPath) {
    outcome = "no_safe_proposal";
    diagnostics.push("No source repository path was available from the readiness packet.");
  } else {
    const unsafeVerification = verificationCommands.map((command, index) => ({ command, index: index + 1, safety: validateCommandSafety(command) })).find((item) => item.safety);
    if (unsafeVerification) {
      outcome = "blocked_by_safety";
      diagnostics.push(`Verification command ${unsafeVerification.index} blocked: ${unsafeVerification.safety?.reason}`);
    } else {
      workspacePath = await prepareWorkspace(repoPath);
      emit("workspace_prepared", { workspacePath });
      proposal = await buildFixtureCodeProposal({
        taskType: "code-proposal",
        repoPath: workspacePath,
        goal: "Prepare a deterministic external proposal patch.",
        allowExternalRepo: true,
        safetyProfile: "safe-local",
        applyMode: "patch-artifact"
      } as RunSpec);
      if (!proposal || proposal.patch.length === 0) {
        outcome = "no_safe_proposal";
        diagnostics.push(proposal?.rationale ?? "No deterministic code proposal rule matched the failure evidence.");
      } else {
        emit("proposal_generated", { filesChanged: proposal.filesChanged });
        applyStatus = await applyPatchInWorkspace(workspacePath, proposal.patch);
        emit("proposal_applied_to_workspace", { applyStatus });
        if (applyStatus !== "applied") {
          outcome = "proposal_ready_unverified";
          diagnostics.push(`Patch could not be applied in disposable workspace: ${applyStatus}`);
        } else {
          verificationResults = await runVerificationCommands({ runId, workspacePath, logsDir, commands: verificationCommands, timeoutMs: options.timeoutMs, maxLogBytes: options.maxLogBytes, markArtifact, emit });
          const allPassed = verificationResults.length > 0 && verificationResults.every((result) => result.status === "passed");
          outcome = allPassed ? "proposal_ready_verified" : "verification_failed";
          if (!allPassed) diagnostics.push("One or more verification commands failed, timed out, or errored in the disposable workspace.");
        }
      }
    }
    originalAfter = await gitSnapshot(repoPath);
    originalRepoMutationVerdict = mutationVerdictFor(originalBefore!, originalAfter);
  }
  const patch = proposal?.patch ?? "";
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const verificationPassed = outcome === "proposal_ready_verified";
  await writeText(join(packetDir, "summary.md"), renderCodeProposalSummary({ runId, outcome, sourceReadinessPacket, repoPath, workspacePath, diagnostics }));
  await markArtifact("summary.md");
  await writeText(join(packetDir, "human-review.md"), renderHumanReview(outcome));
  await markArtifact("human-review.md");
  await writeText(join(packetDir, "proposal.patch"), patch);
  await markArtifact("proposal.patch", "patch");
  await writeText(join(packetDir, "patch-summary.md"), renderPatchSummary(proposal, outcome, diagnostics));
  await markArtifact("patch-summary.md");
  await writeJson(join(packetDir, "proposal-status.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    outcome,
    humanGate: "required",
    sourceReadinessPacket,
    sourceTriagePacket: contract.sourceTriagePacket ?? null,
    sourceCheckPacket: contract.sourceCheckPacket ?? null,
    workspacePath,
    applyStatus,
    filesChanged: proposal?.filesChanged ?? [],
    patchBytes: Buffer.byteLength(patch, "utf8"),
    verificationPassed,
    diagnostics
  });
  await markArtifact("proposal-status.json");
  await writeJson(join(packetDir, "verification-results.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    verificationPassed,
    commands: verificationResults
  });
  await markArtifact("verification-results.json");
  await writeJson(join(packetDir, "before-command-results.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    source: sourceCheckPacket ?? null,
    commands: beforeResults
  });
  await markArtifact("before-command-results.json");
  await writeJson(join(packetDir, "after-command-results.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    workspacePath,
    commands: verificationResults
  });
  await markArtifact("after-command-results.json");
  await writeJson(join(packetDir, "run.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    taskType: "external_code_proposal",
    status: outcome,
    startedAt,
    finishedAt,
    durationMs,
    sourceReadinessPacket,
    repo: repoPath ? {
      path: repoPath,
      mutationVerdict: originalRepoMutationVerdict,
      headBefore: originalBefore?.head ?? null,
      headAfter: originalAfter?.head ?? null,
      statusBefore: originalBefore?.status ?? null,
      statusAfter: originalAfter?.status ?? null
    } : null,
    workspace: { path: workspacePath },
    artifactDir: packetDir
  });
  await markArtifact("run.json");
  await writeJson(join(packetDir, "metrics.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    durationMs,
    outcome,
    patchBytes: Buffer.byteLength(patch, "utf8"),
    verificationCommandsRun: verificationResults.length,
    verificationCommandsPassed: verificationResults.filter((result) => result.status === "passed").length,
    originalRepoMutationVerdict,
    humanGateRequired: true
  });
  await markArtifact("metrics.json");
  await writeJson(join(packetDir, "safety-report.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    sourceReadinessPacket,
    originalRepoMutationAllowed: false,
    originalRepoBefore: originalBefore,
    originalRepoAfter: originalAfter,
    originalRepoMutationVerdict,
    workspacePath,
    patchAppliedOnlyInDisposableWorkspace: applyStatus === "applied",
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    humanGateRequired: true,
    blockedBySafety: outcome === "blocked_by_safety"
  });
  await markArtifact("safety-report.json");
  await writeJson(join(packetDir, "trajectory.json"), {
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    taskType: "external_code_proposal",
    steps: [
      { type: "route_selected", route: "external_code_proposal" },
      { type: "source_packet_selected", status: "finished" },
      { type: "workspace_prepared", status: workspacePath ? "finished" : "skipped" },
      { type: "proposal_generated", status: proposal?.patch ? "finished" : "skipped" },
      { type: "verification", status: verificationResults.length > 0 ? "finished" : "skipped", passed: verificationPassed },
      { type: "summary", status: "written" }
    ]
  });
  await markArtifact("trajectory.json");
  emit("run_finished", { status: outcome, verificationPassed });
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await markArtifact("events.jsonl");
  await writePacketManifest(packetDir, artifacts);
  await markArtifact("packet-manifest.json");
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return {
    runId,
    outcome,
    packetDir,
    sourceReadinessPacket,
    proposalPatchBytes: Buffer.byteLength(patch, "utf8"),
    verificationPassed,
    originalRepoMutationVerdict
  };
}

export { renderExternalCodeProposalCliSummary };

function validateOptions(options: ExternalCodeProposalOptions): void {
  const hasPacket = Boolean(options.fromReadinessPacket);
  const hasRepoCommand = Boolean(options.repo) || Boolean(options.commands && options.commands.length > 0);
  if (hasPacket && hasRepoCommand) throw new Error("Use either --from-readiness-packet or --repo with --command, not both.");
  if (!hasPacket && !options.repo) throw new Error("--repo is required when --from-readiness-packet is not provided.");
  if (!hasPacket && (!options.commands || options.commands.length === 0)) {
    throw new Error("At least one --command is required when --from-readiness-packet is not provided.");
  }
  if (options.commands?.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
}
async function createSourceReadinessPacket(
  options: ExternalCodeProposalOptions,
  outRoot: string,
  emit: (type: string, data?: object) => string
): Promise<string> {
  const readinessOut = join(outRoot, "readiness-source");
  emit("source_readiness_started", { readinessOut });
  const result = await runExternalProposalReadiness({
    repo: options.repo,
    commands: options.commands,
    out: readinessOut,
    timeoutMs: options.timeoutMs,
    maxLogBytes: options.maxLogBytes
  });
  emit("source_readiness_finished", { readinessOut, sourceReadinessPacket: result.packetDir, readinessOutcome: result.readinessOutcome });
  return result.packetDir;
}

async function readReadinessContract(packetDir: string): Promise<ReadinessContract> {
  await access(join(packetDir, "proposal-contract.json"));
  return JSON.parse(await readFile(join(packetDir, "proposal-contract.json"), "utf8")) as ReadinessContract;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function defaultOutDir(): string {
  return join(process.cwd(), "artifacts", "external-code-proposal");
}
