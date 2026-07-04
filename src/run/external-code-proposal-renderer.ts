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
    "- verification-results.json"
  ].join("\n");
}

export function renderCodeProposalSummary(input: {
  runId: string;
  outcome: CodeProposalOutcome;
  sourceReadinessPacket: string;
  repoPath?: string;
  workspacePath?: string;
  diagnostics: string[];
}): string {
  return `# Code Proposal

Run ID: ${input.runId}

Outcome: ${input.outcome}

Source readiness packet: ${input.sourceReadinessPacket}

Original repo: ${input.repoPath ?? "unknown"}

Disposable workspace: ${input.workspacePath ?? "not prepared"}

Diagnostics:
${input.diagnostics.length > 0 ? input.diagnostics.map((item) => `- ${item}`).join("\n") : "- No diagnostics."}

Human review is required before applying proposal.patch anywhere outside the disposable workspace.
`;
}

export function renderHumanReview(outcome: CodeProposalOutcome): string {
  return `# Human Review

Outcome: ${outcome}

- proposal.patch was not applied to the original repository.
- Verification, when present, ran only in a disposable workspace.
- Human gate: required.
- Do not apply the patch unless the packet evidence and patch are acceptable.
`;
}

export function renderPatchSummary(proposal: DeterministicCodeProposal | null, outcome: CodeProposalOutcome, diagnostics: string[]): string {
  return `# Patch Summary

Outcome: ${outcome}

Files changed:
${proposal?.filesChanged.length ? proposal.filesChanged.map((file) => `- ${file}`).join("\n") : "- No files changed."}

Rationale:
${proposal?.rationale ?? "No deterministic safe proposal was generated."}

Diagnostics:
${diagnostics.length > 0 ? diagnostics.map((item) => `- ${item}`).join("\n") : "- No diagnostics."}
`;
}
