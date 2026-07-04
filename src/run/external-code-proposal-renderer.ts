import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import type { CodeProposalOutcome, ExternalCodeProposalResult } from "./external-code-proposal.js";

export function renderExternalCodeProposalCliSummary(result: ExternalCodeProposalResult): string {
  return [
    "RunForge external code proposal",
    "",
    `Run ID: ${result.runId}`,
    `Outcome: ${result.outcome}`,
    `Verification passed: ${result.verificationPassed}`,
    `Source readiness packet: ${result.sourceReadinessPacket}`,
    `Packet: ${result.packetDir}`,
    `Proposal patch bytes: ${result.proposalPatchBytes}`,
    `Original repo: ${result.originalRepoMutationVerdict}`,
    "",
    "Key artifacts:",
    "- summary.md",
    "- human-review.md",
    "- proposal.patch",
    "- patch-summary.md",
    "- proposal-status.json",
    "- verification-results.json",
    "- worker-notes/"
  ].join("\n");
}

interface PacketOverview {
  strategy: string | null;
  reviewerDecision: string;
  reviewerReason: string;
  filesChanged: string[];
  verificationCommands: string[];
  originalRepoMutationVerdict: string;
}

export function renderCodeProposalSummary(input: {
  runId: string;
  outcome: CodeProposalOutcome;
  sourceReadinessPacket: string;
  repoPath?: string;
  workspacePath?: string;
  diagnostics: string[];
  packetOverview: PacketOverview;
}): string {
  return `# Code Proposal

Run ID: ${input.runId}

Outcome: ${input.outcome}

Patch generated: ${input.packetOverview.filesChanged.length > 0 ? "yes" : "no"}

Verified: ${input.outcome === "proposal_ready_verified" ? "yes" : "no"}

Strategy: ${input.packetOverview.strategy ?? "none"}

Reviewer decision: ${input.packetOverview.reviewerDecision}

Reviewer reason: ${input.packetOverview.reviewerReason}

Source readiness packet: ${input.sourceReadinessPacket}

Original repo: ${input.repoPath ?? "unknown"}

Original repo mutation verdict: ${input.packetOverview.originalRepoMutationVerdict}

Disposable workspace: ${input.workspacePath ?? "not prepared"}

Files that would change:
${input.packetOverview.filesChanged.length > 0 ? input.packetOverview.filesChanged.map((file) => `- ${file}`).join("\n") : "- No files changed."}

Verification commands:
${input.packetOverview.verificationCommands.length > 0 ? input.packetOverview.verificationCommands.map((command) => `- ${command}`).join("\n") : "- No verification commands ran."}

Diagnostics:
${input.diagnostics.length > 0 ? input.diagnostics.map((item) => `- ${item}`).join("\n") : "- No diagnostics."}

Worker trace:
- readiness_loader
- context_scout
- failure_analyst
- proposal_planner
- patch_writer
- verifier
- proposal_reviewer
- packet_writer

Human review is required before applying proposal.patch anywhere outside the disposable workspace.
`;
}

export function renderHumanReview(outcome: CodeProposalOutcome, overview: PacketOverview): string {
  return `# Human Review

Outcome: ${outcome}

Reviewer decision: ${overview.reviewerDecision}

Strategy: ${overview.strategy ?? "none"}

Files that would change:
${overview.filesChanged.length > 0 ? overview.filesChanged.map((file) => `- ${file}`).join("\n") : "- No files changed."}

Verification commands:
${overview.verificationCommands.length > 0 ? overview.verificationCommands.map((command) => `- ${command}`).join("\n") : "- No verification commands ran."}

- proposal.patch was not applied to the original repository.
- Verification, when present, ran only in a disposable workspace.
- Human gate: required.
- Do not apply the patch unless the packet evidence and patch are acceptable.
`;
}

export function renderPatchSummary(proposal: DeterministicCodeProposal | null, outcome: CodeProposalOutcome, diagnostics: string[], overview: PacketOverview): string {
  return `# Patch Summary

Outcome: ${outcome}

Strategy: ${proposal?.strategy ?? "none"}

Reviewer decision: ${overview.reviewerDecision}

Files changed:
${proposal?.filesChanged.length ? proposal.filesChanged.map((file) => `- ${file}`).join("\n") : "- No files changed."}

Rationale:
${proposal?.rationale ?? "No deterministic safe proposal was generated."}

Evidence:
${proposal?.evidenceSummary?.length ? proposal.evidenceSummary.map((item) => `- ${item}`).join("\n") : "- No proposal evidence accepted."}

Diagnostics:
${diagnostics.length > 0 ? diagnostics.map((item) => `- ${item}`).join("\n") : "- No diagnostics."}
`;
}
