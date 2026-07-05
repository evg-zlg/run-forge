import { join, resolve } from "node:path";
import { ensureDir } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import type { RunSpec } from "../core/types.js";
import { buildFixtureCodeProposal, type DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { validateCommandSafety } from "./command-safety.js";
import { gitSnapshot, mutationVerdictFor, prepareWorkspace } from "./external-command-check-git.js";
import { writePacketManifest } from "./external-command-check-packet.js";
import type { CommandResult } from "./external-command-check-types.js";
import { createCodeProposalArtifactTracker } from "./external-code-proposal-artifacts.js";
import {
  createSourceReadinessPacket,
  defaultOutDir,
  readOptionalJson,
  readReadinessContract,
  validateOptions
} from "./external-code-proposal-inputs.js";
import { renderExternalCodeProposalCliSummary } from "./external-code-proposal-renderer.js";
import { writeCodeProposalPacket, writeEvents } from "./external-code-proposal-packet.js";
import { runProviderProposalWorkers, validateProviderOptions, type ProviderProposalOptions, type ProviderProposalResult } from "./external-code-proposal-provider.js";
import {
  createWorkerRunner,
  readFailureEvidenceText,
  reviewProposal,
  type ReviewerDecision,
  type WorkerNote
} from "./external-code-proposal-workers.js";
import { applyPatchInWorkspace, runVerificationCommands, verificationCommandsFor } from "./external-code-proposal-workspace.js";
export const externalCodeProposalSchemaVersion = "alpha-3c";

export type CodeProposalOutcome =
  | "proposal_ready_verified"
  | "proposal_ready_unverified"
  | "no_safe_proposal"
  | "not_ready"
  | "verification_failed"
  | "blocked_by_safety"
  | "provider_rejected"
  | "provider_failed";

export interface ExternalCodeProposalOptions {
  fromReadinessPacket?: string;
  repo?: string;
  commands?: string[];
  out?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  runId?: string;
  enableProviderProposal?: boolean;
  provider?: "cli";
  providerCommand?: string;
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

interface CheckRun {
  repo?: { path?: string };
  commands?: CommandResult[];
}

export async function runExternalCodeProposal(options: ExternalCodeProposalOptions): Promise<ExternalCodeProposalResult> {
  validateOptions(options);
  validateProviderOptions({
    enabled: options.enableProviderProposal,
    provider: options.provider,
    providerCommand: options.providerCommand
  });
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const outRoot = resolve(options.out ?? defaultOutDir());
  const packetDir = join(outRoot, "packet");
  const logsDir = join(packetDir, "logs");
  const workerNotesDir = join(packetDir, "worker-notes");
  await ensureDir(logsDir);
  await ensureDir(workerNotesDir);

  const { events, artifacts, emit, markArtifact } = createCodeProposalArtifactTracker({
    runId,
    packetDir,
    schemaVersion: externalCodeProposalSchemaVersion
  });
  const workerNotes: WorkerNote[] = [];
  const runWorker = createWorkerRunner({ runId, packetDir, emit, markArtifact, workerNotes });

  emit("task_received", {
    taskType: "external_code_proposal",
    inputMode: options.fromReadinessPacket ? "from_readiness_packet" : "repo_command"
  });
  emit("route_selected", { route: "external_code_proposal" });
  const sourceReadinessPacket = await runWorker("readiness_loader", async () => {
    const packet = options.fromReadinessPacket
      ? resolve(options.fromReadinessPacket)
      : await createSourceReadinessPacket(options, outRoot, emit);
    emit("source_packet_selected", { sourceReadinessPacket: packet });
    return {
      status: "finished",
      lines: [
        `Input mode: ${options.fromReadinessPacket ? "from readiness packet" : "repo command chain"}.`,
        `Selected readiness packet: ${packet}.`
      ],
      output: packet
    };
  });
  const contract = await readReadinessContract(sourceReadinessPacket);
  const sourceCheckPacket = contract.sourceCheckPacket ? resolve(contract.sourceCheckPacket) : undefined;
  const sourceCheckRun = sourceCheckPacket ? await readOptionalJson<CheckRun>(join(sourceCheckPacket, "run.json")) : null;
  const context = await runWorker("context_scout", async () => {
    const repo = sourceCheckRun?.repo?.path ? resolve(sourceCheckRun.repo.path) : options.repo ? resolve(options.repo) : undefined;
    const commands = verificationCommandsFor(contract, sourceCheckRun, options.commands);
    return {
      status: repo ? "finished" : "insufficient_context",
      lines: [
        `Source check packet: ${sourceCheckPacket ?? "none"}.`,
        `Repository path: ${repo ?? "unavailable"}.`,
        `Verification commands: ${commands.length > 0 ? commands.join(" | ") : "none"}.`
      ],
      output: { repoPath: repo, verificationCommands: commands }
    };
  });
  const repoPath = context.repoPath;
  const verificationCommands = context.verificationCommands;
  const failureEvidence = await runWorker("failure_analyst", async () => {
    const evidenceText = sourceCheckPacket && sourceCheckRun ? await readFailureEvidenceText(sourceCheckPacket, sourceCheckRun) : "";
    const failedCommands = sourceCheckRun?.commands?.filter((result) => result.status !== "passed").length ?? 0;
    return {
      status: evidenceText ? "finished" : "no_evidence_logs",
      lines: [
        `Failure category: ${contract.failureCategory ?? "unknown"}.`,
        `Failed command count: ${failedCommands}.`,
        `Evidence text bytes: ${Buffer.byteLength(evidenceText, "utf8")}.`
      ],
      output: evidenceText
    };
  });
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
  let reviewerDecision: ReviewerDecision = "rejected_insufficient_evidence";
  let reviewerReason = "Reviewer did not run.";
  let providerResult: ProviderProposalResult | null = null;
  const providerOptions: ProviderProposalOptions = {
    enabled: options.enableProviderProposal,
    provider: options.provider,
    providerCommand: options.providerCommand
  };

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
      proposal = await runWorker("proposal_planner", async () => {
        const planned = await buildFixtureCodeProposal({
          taskType: "code-proposal",
          repoPath: workspacePath!,
          goal: "Prepare a deterministic external proposal patch.",
          allowExternalRepo: true,
          safetyProfile: "safe-local",
          applyMode: "patch-artifact"
        } as RunSpec, undefined, {
          failureCategory: contract.failureCategory,
          evidenceText: failureEvidence
        });
        return {
          status: planned?.patch ? "strategy_selected" : "no_safe_strategy",
          lines: [
            `Readiness allowed proposal: ${contract.canAttemptCodeProposal}.`,
            `Selected strategy: ${planned?.strategy ?? "none"}.`,
            `Files planned: ${planned?.filesChanged.length ? planned.filesChanged.join(", ") : "none"}.`,
            planned?.rationale ?? "No deterministic proposal rule matched the evidence and repository context."
          ],
          output: planned
        };
      });
      if ((!proposal || proposal.patch.length === 0) && providerOptions.enabled) {
        providerResult = await runProviderProposalWorkers({
          runWorker,
          providerCommand: options.providerCommand!,
          packetDir,
          repoPath: repoPath!,
          failureEvidence,
          verificationCommands,
          failureCategory: contract.failureCategory,
          provider: providerOptions.provider,
          contract
        });
        if (providerResult.status === "accepted" && providerResult.proposal) {
          proposal = providerResult.proposal;
        } else {
          outcome = providerResult.status === "failed" ? "provider_failed" : "provider_rejected";
          diagnostics.push(...providerResult.errors);
        }
      }
      if (!proposal || proposal.patch.length === 0) {
        if (outcome !== "provider_failed" && outcome !== "provider_rejected") {
          outcome = "no_safe_proposal";
          diagnostics.push(proposal?.rationale ?? "No deterministic code proposal rule matched the failure evidence.");
        }
      } else {
        await runWorker("patch_writer", async () => {
          emit("proposal_generated", { filesChanged: proposal!.filesChanged, strategy: proposal!.strategy ?? "unknown" });
          applyStatus = await applyPatchInWorkspace(workspacePath!, proposal!.patch);
          emit("proposal_applied_to_workspace", { applyStatus });
          return {
            status: applyStatus === "applied" ? "patch_applied_to_workspace" : "patch_apply_failed",
            lines: [
              `Strategy: ${proposal!.strategy ?? "unknown"}.`,
              `Patch bytes: ${Buffer.byteLength(proposal!.patch, "utf8")}.`,
              `Files changed: ${proposal!.filesChanged.join(", ")}.`,
              `Disposable workspace apply status: ${applyStatus}.`,
              "Refused to apply the patch to the original repository."
            ],
            output: null
          };
        });
        if (applyStatus !== "applied") {
          outcome = "proposal_ready_unverified";
          diagnostics.push(`Patch could not be applied in disposable workspace: ${applyStatus}`);
        } else {
          verificationResults = await runWorker("verifier", async () => {
            const results = await runVerificationCommands({ runId, workspacePath: workspacePath!, logsDir, commands: verificationCommands, timeoutMs: options.timeoutMs, maxLogBytes: options.maxLogBytes, markArtifact, emit });
            const passed = results.length > 0 && results.every((result) => result.status === "passed");
            return {
              status: passed ? "verification_passed" : "verification_failed",
              lines: [
                `Commands run: ${results.length}.`,
                ...results.map((result) => `${result.index}. ${result.command} -> ${result.status} (exit ${result.exitCode ?? "null"})`)
              ],
              output: results
            };
          });
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
  const review = await runWorker("proposal_reviewer", async () => {
    const result = reviewProposal({
      outcome,
      proposal,
      patch,
      verificationResults,
      originalRepoMutationVerdict,
      applyStatus
    });
    reviewerDecision = result.decision;
    reviewerReason = result.reason;
    return {
      status: result.decision,
      lines: [
        `Decision: ${result.decision}.`,
        `Reason: ${result.reason}.`,
        `Human gate: required.`,
        `Original repo mutation verdict: ${originalRepoMutationVerdict}.`
      ],
      output: result
    };
  });
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const verificationPassed = outcome === "proposal_ready_verified";
  await writeCodeProposalPacket({
    schemaVersion: externalCodeProposalSchemaVersion,
    runId,
    packetDir,
    outcome,
    sourceReadinessPacket,
    sourceTriagePacket: contract.sourceTriagePacket ?? null,
    sourceCheckPacket: contract.sourceCheckPacket ?? null,
    repoPath,
    workspacePath,
    diagnostics,
    proposal,
    patch,
    applyStatus,
    verificationResults,
    verificationCommands,
    beforeResults,
    verificationPassed,
    reviewerDecision,
    reviewerReason,
    originalRepoMutationVerdict,
    originalBefore,
    originalAfter,
    startedAt,
    finishedAt,
    durationMs,
    workerNotes,
    review,
    provider: {
      enabled: Boolean(providerOptions.enabled),
      backend: providerOptions.provider ?? null,
      result: providerResult
    },
    markArtifact,
    runWorker
  });
  emit("run_finished", { status: outcome, verificationPassed });
  await writeEvents(packetDir, events);
  await markArtifact("events.jsonl");
  await writePacketManifest(packetDir, artifacts);
  await markArtifact("packet-manifest.json");
  await writeEvents(packetDir, events);
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
