import type { TriageRootCause, ReadinessDecision } from "./external-proposal-readiness.js";
import type { ExternalProposalReadinessResult } from "./external-proposal-readiness.js";

export function renderExternalProposalReadinessCliSummary(result: ExternalProposalReadinessResult): string {
  return [
    "RunForge external proposal readiness",
    "",
    `Run ID: ${result.runId}`,
    `Outcome: ${result.readinessOutcome}`,
    `Can attempt code proposal: ${result.canAttemptCodeProposal}`,
    `Category: ${result.failureCategory}`,
    `Confidence: ${result.confidence}`,
    `Source triage packet: ${result.sourceTriagePacket}`,
    `Packet: ${result.packetDir}`,
    "",
    `Recommended next action: ${result.recommendedNextAction}`,
    "",
    "Key artifacts:",
    "- summary.md",
    "- proposal-readiness.md",
    "- proposal-contract.json",
    "- missing-context.md",
    "- recommended-next-action.md"
  ].join("\n");
}

export function renderReadinessSummary(input: {
  runId: string;
  sourceTriagePacket: string;
  rootCause: TriageRootCause;
  decision: ReadinessDecision;
}): string {
  return `# Proposal Readiness

Run ID: ${input.runId}

Outcome: ${input.decision.readinessOutcome}

Can attempt code proposal: ${input.decision.canAttemptCodeProposal}

Source triage packet: ${input.sourceTriagePacket}

Failure category: ${input.decision.failureCategory}

Confidence: ${input.decision.confidence}

Recommended next action: ${input.decision.recommendedNextAction}
`;
}

export function renderReadinessHumanReview(decision: ReadinessDecision): string {
  return `# Human Review

RunForge has only decided proposal readiness.

- Outcome: ${decision.readinessOutcome}
- Code proposal allowed by contract: ${decision.canAttemptCodeProposal}
- Human gate: required
- Original repository mutation: forbidden

Review proposal-contract.json before running a code proposal.
`;
}

export function renderProposalReadiness(input: {
  sourceTriagePacket: string;
  rootCause: TriageRootCause;
  decision: ReadinessDecision;
}): string {
  const evidence = input.rootCause.evidenceBasis?.map((item) => `- ${item}`).join("\n") ?? "- No evidence basis recorded.";
  return `# Proposal Readiness Decision

## Source

${input.sourceTriagePacket}

## Decision

- Outcome: ${input.decision.readinessOutcome}
- Can attempt code proposal: ${input.decision.canAttemptCodeProposal}
- Failure category: ${input.decision.failureCategory}
- Confidence: ${input.decision.confidence}

## Evidence Basis

${evidence}
`;
}

export function renderMissingContext(decision: ReadinessDecision): string {
  if (decision.missingContext.length === 0) return "No missing context identified for the current deterministic proposal scope.\n";
  return `${decision.missingContext.map((item) => `- ${item}`).join("\n")}\n`;
}
