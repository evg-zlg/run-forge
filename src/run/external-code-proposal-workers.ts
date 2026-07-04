import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeText } from "../core/artifact-store.js";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import type { CodeProposalOutcome } from "./external-code-proposal.js";
import type { CommandResult } from "./external-command-check-types.js";

export type ReviewerDecision =
  | "accepted_for_human_review"
  | "rejected_no_safe_proposal"
  | "rejected_verification_failed"
  | "rejected_scope_too_broad"
  | "rejected_insufficient_evidence";

export interface WorkerNote {
  workerId: string;
  workerRole: string;
  artifactPath: string;
  status: string;
  lines: string[];
}

export interface CheckRunForEvidence {
  commands?: CommandResult[];
}

export function createWorkerRunner(input: {
  runId: string;
  packetDir: string;
  emit: (type: string, data?: object) => string;
  markArtifact: (path: string, artifactType?: string) => Promise<void>;
  workerNotes: WorkerNote[];
}) {
  return async function runWorker<T>(
    workerRole: string,
    body: (workerId: string) => Promise<{ status: string; lines: string[]; output: T }>
  ): Promise<T> {
    const workerId = `${input.runId}:worker:${workerRole}`;
    const startedEventId = input.emit("worker_started", { workerId, workerRole, status: "started" });
    try {
      const result = await body(workerId);
      await writeWorkerNote(input, workerId, workerRole, result.status, result.lines, startedEventId);
      return result.output;
    } catch (error) {
      await writeWorkerNote(input, workerId, workerRole, "error", [`Error: ${errorMessage(error)}`], startedEventId);
      throw error;
    }
  };
}

export async function readFailureEvidenceText(sourceCheckPacket: string, sourceCheckRun: CheckRunForEvidence): Promise<string> {
  const chunks: string[] = [];
  for (const result of sourceCheckRun.commands?.filter((command) => command.status !== "passed") ?? []) {
    chunks.push(`Command ${result.index}: ${result.command}`);
    chunks.push(await readOptionalText(join(sourceCheckPacket, result.stdoutPath)));
    chunks.push(await readOptionalText(join(sourceCheckPacket, result.stderrPath)));
  }
  return chunks.filter((chunk) => chunk.length > 0).join("\n");
}

export function reviewProposal(input: {
  outcome: CodeProposalOutcome;
  proposal: DeterministicCodeProposal | null;
  patch: string;
  verificationResults: CommandResult[];
  originalRepoMutationVerdict: string;
  applyStatus: string;
}): { decision: ReviewerDecision; reason: string } {
  if (input.originalRepoMutationVerdict === "changed") return { decision: "rejected_scope_too_broad", reason: "Original repository mutation was detected." };
  if (!input.proposal || input.patch.length === 0 || input.outcome === "no_safe_proposal" || input.outcome === "not_ready") {
    return { decision: "rejected_no_safe_proposal", reason: "No proposal patch was generated for this packet." };
  }
  if (!input.proposal.strategy || !input.proposal.evidenceSummary?.length) {
    return { decision: "rejected_insufficient_evidence", reason: "Proposal did not include strategy and evidence summary metadata." };
  }
  if (input.proposal.filesChanged.length !== 1 || input.patch.length > 20_000) {
    return { decision: "rejected_scope_too_broad", reason: "Proposal must change exactly one file and remain small for Alpha-4 deterministic review." };
  }
  if (input.applyStatus !== "applied") return { decision: "rejected_verification_failed", reason: `Patch did not apply cleanly in the disposable workspace: ${input.applyStatus}.` };
  const verificationPassed = input.verificationResults.length > 0 && input.verificationResults.every((result) => result.status === "passed");
  if (!verificationPassed || input.outcome === "verification_failed") return { decision: "rejected_verification_failed", reason: "Verification did not pass in the disposable workspace." };
  if (input.outcome !== "proposal_ready_verified") return { decision: "rejected_insufficient_evidence", reason: `Outcome ${input.outcome} is not accepted for human review.` };
  return { decision: "accepted_for_human_review", reason: "Patch is narrow, evidence-backed, verified in a disposable workspace, and still requires human review." };
}

async function writeWorkerNote(
  input: Parameters<typeof createWorkerRunner>[0],
  workerId: string,
  workerRole: string,
  status: string,
  lines: string[],
  startedEventId: string
): Promise<void> {
  const artifactPath = `worker-notes/${workerRole.replaceAll("_", "-")}.md`;
  await writeText(join(input.packetDir, artifactPath), renderWorkerNote(workerRole, status, lines));
  await input.markArtifact(artifactPath, "note");
  input.workerNotes.push({ workerId, workerRole, artifactPath, status, lines });
  input.emit("worker_finished", { parentEventId: startedEventId, workerId, workerRole, status, outputArtifactPaths: [artifactPath] });
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function renderWorkerNote(workerRole: string, status: string, lines: string[]): string {
  return `# ${workerRole.replaceAll("_", " ")}

Status: ${status}

${lines.map((line) => `- ${line}`).join("\n")}
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
