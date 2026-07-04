import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson, writeText } from "../core/artifact-store.js";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import type { CodeProposalOutcome } from "./external-code-proposal.js";
import {
  renderCodeProposalSummary,
  renderHumanReview,
  renderPatchSummary
} from "./external-code-proposal-renderer.js";
import type { CommandResult, GitSnapshot } from "./external-command-check-types.js";
import type { ReviewerDecision, WorkerNote } from "./external-code-proposal-workers.js";

export interface CodeProposalPacketInput {
  schemaVersion: string;
  runId: string;
  packetDir: string;
  outcome: CodeProposalOutcome;
  sourceReadinessPacket: string;
  sourceTriagePacket?: string | null;
  sourceCheckPacket?: string | null;
  repoPath?: string;
  workspacePath?: string;
  diagnostics: string[];
  proposal: DeterministicCodeProposal | null;
  patch: string;
  applyStatus: string;
  verificationResults: CommandResult[];
  verificationCommands: string[];
  beforeResults: CommandResult[];
  verificationPassed: boolean;
  reviewerDecision: ReviewerDecision;
  reviewerReason: string;
  originalRepoMutationVerdict: string;
  originalBefore: GitSnapshot | null;
  originalAfter: GitSnapshot | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workerNotes: WorkerNote[];
  review: { decision: ReviewerDecision; reason: string };
  markArtifact: (path: string, artifactType?: string) => Promise<void>;
  runWorker: <T>(workerRole: string, body: (workerId: string) => Promise<{ status: string; lines: string[]; output: T }>) => Promise<T>;
}

export async function writeCodeProposalPacket(input: CodeProposalPacketInput): Promise<void> {
  const overview = {
    strategy: input.proposal?.strategy ?? null,
    reviewerDecision: input.reviewerDecision,
    reviewerReason: input.reviewerReason,
    filesChanged: input.proposal?.filesChanged ?? [],
    verificationCommands: input.verificationCommands,
    originalRepoMutationVerdict: input.originalRepoMutationVerdict
  };
  await writeText(join(input.packetDir, "summary.md"), renderCodeProposalSummary({ ...input, packetOverview: overview }));
  await input.markArtifact("summary.md");
  await writeText(join(input.packetDir, "human-review.md"), renderHumanReview(input.outcome, overview));
  await input.markArtifact("human-review.md");
  await writeText(join(input.packetDir, "proposal.patch"), input.patch);
  await input.markArtifact("proposal.patch", "patch");
  await writeText(join(input.packetDir, "patch-summary.md"), renderPatchSummary(input.proposal, input.outcome, input.diagnostics, overview));
  await input.markArtifact("patch-summary.md");
  await writeJson(join(input.packetDir, "proposal-status.json"), proposalStatus(input));
  await input.markArtifact("proposal-status.json");
  await writeJson(join(input.packetDir, "verification-results.json"), {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    verificationPassed: input.verificationPassed,
    verificationCommands: input.verificationCommands,
    commands: input.verificationResults
  });
  await input.markArtifact("verification-results.json");
  await writeJson(join(input.packetDir, "before-command-results.json"), { schemaVersion: input.schemaVersion, runId: input.runId, source: input.sourceCheckPacket ?? null, commands: input.beforeResults });
  await input.markArtifact("before-command-results.json");
  await writeJson(join(input.packetDir, "after-command-results.json"), { schemaVersion: input.schemaVersion, runId: input.runId, workspacePath: input.workspacePath, commands: input.verificationResults });
  await input.markArtifact("after-command-results.json");
  await writeJson(join(input.packetDir, "run.json"), runJson(input));
  await input.markArtifact("run.json");
  await writeJson(join(input.packetDir, "metrics.json"), metricsJson(input));
  await input.markArtifact("metrics.json");
  await writeJson(join(input.packetDir, "safety-report.json"), safetyJson(input));
  await input.markArtifact("safety-report.json");
  await input.runWorker("packet_writer", async () => ({
    status: "packet_written",
    lines: [
      "Packet artifacts were written for human review.",
      `Outcome: ${input.outcome}.`,
      `Reviewer decision: ${input.reviewerDecision}.`,
      "Human gate remains required before applying proposal.patch anywhere outside the disposable workspace."
    ],
    output: null
  }));
  await writeJson(join(input.packetDir, "trajectory.json"), trajectoryJson(input));
  await input.markArtifact("trajectory.json");
}

export async function writeEvents(packetDir: string, events: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(packetDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function proposalStatus(input: CodeProposalPacketInput) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    outcome: input.outcome,
    humanGate: "required",
    sourceReadinessPacket: input.sourceReadinessPacket,
    sourceTriagePacket: input.sourceTriagePacket ?? null,
    sourceCheckPacket: input.sourceCheckPacket ?? null,
    workspacePath: input.workspacePath,
    applyStatus: input.applyStatus,
    strategy: input.proposal?.strategy ?? null,
    reviewerDecision: input.reviewerDecision,
    reviewerReason: input.reviewerReason,
    filesChanged: input.proposal?.filesChanged ?? [],
    patchBytes: Buffer.byteLength(input.patch, "utf8"),
    verificationPassed: input.verificationPassed,
    diagnostics: input.diagnostics
  };
}

function runJson(input: CodeProposalPacketInput) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    taskType: "external_code_proposal",
    status: input.outcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    sourceReadinessPacket: input.sourceReadinessPacket,
    repo: input.repoPath ? {
      path: input.repoPath,
      mutationVerdict: input.originalRepoMutationVerdict,
      headBefore: input.originalBefore?.head ?? null,
      headAfter: input.originalAfter?.head ?? null,
      statusBefore: input.originalBefore?.status ?? null,
      statusAfter: input.originalAfter?.status ?? null
    } : null,
    workspace: { path: input.workspacePath },
    artifactDir: input.packetDir
  };
}

function metricsJson(input: CodeProposalPacketInput) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    durationMs: input.durationMs,
    outcome: input.outcome,
    patchBytes: Buffer.byteLength(input.patch, "utf8"),
    strategy: input.proposal?.strategy ?? null,
    reviewerDecision: input.reviewerDecision,
    verificationCommandsRun: input.verificationResults.length,
    verificationCommandsPassed: input.verificationResults.filter((result) => result.status === "passed").length,
    originalRepoMutationVerdict: input.originalRepoMutationVerdict,
    humanGateRequired: true
  };
}

function safetyJson(input: CodeProposalPacketInput) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    sourceReadinessPacket: input.sourceReadinessPacket,
    originalRepoMutationAllowed: false,
    originalRepoBefore: input.originalBefore,
    originalRepoAfter: input.originalAfter,
    originalRepoMutationVerdict: input.originalRepoMutationVerdict,
    workspacePath: input.workspacePath,
    patchAppliedOnlyInDisposableWorkspace: input.applyStatus === "applied",
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    humanGateRequired: true,
    blockedBySafety: input.outcome === "blocked_by_safety"
  };
}

function trajectoryJson(input: CodeProposalPacketInput) {
  return {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    taskType: "external_code_proposal",
    steps: [
      { type: "route_selected", route: "external_code_proposal" },
      ...input.workerNotes.map((note) => ({ type: "worker", workerId: note.workerId, workerRole: note.workerRole, status: note.status, outputArtifactPaths: [note.artifactPath] })),
      { type: "workspace_prepared", status: input.workspacePath ? "finished" : "skipped" },
      { type: "proposal_generated", status: input.proposal?.patch ? "finished" : "skipped", strategy: input.proposal?.strategy ?? null },
      { type: "verification", status: input.verificationResults.length > 0 ? "finished" : "skipped", passed: input.verificationPassed },
      { type: "review", status: input.review.decision, reason: input.review.reason },
      { type: "summary", status: "written" }
    ]
  };
}
