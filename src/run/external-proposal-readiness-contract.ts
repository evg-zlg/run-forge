import type { ReadinessDecision, TriageRootCause } from "./external-proposal-readiness.js";
import { externalProposalReadinessSchemaVersion } from "./external-proposal-readiness.js";

export function buildProposalContract(input: {
  runId: string;
  sourceTriagePacket: string;
  rootCause: TriageRootCause;
  decision: ReadinessDecision;
}) {
  const base = {
    schemaVersion: externalProposalReadinessSchemaVersion,
    runId: input.runId,
    readinessOutcome: input.decision.readinessOutcome,
    canAttemptCodeProposal: input.decision.canAttemptCodeProposal,
    sourceTriagePacket: input.sourceTriagePacket,
    sourceCheckPacket: input.rootCause.sourceCheckPacket ?? null,
    failureCategory: input.decision.failureCategory,
    confidence: input.decision.confidence
  };
  if (!input.decision.canAttemptCodeProposal) {
    return {
      ...base,
      missingContext: input.decision.missingContext,
      recommendedNextAction: input.decision.recommendedNextAction,
      humanGate: "required"
    };
  }
  return {
    ...base,
    allowedActions: [
      "create proposal patch in disposable workspace",
      "run verification commands in disposable workspace"
    ],
    forbiddenActions: [
      "mutate original repo",
      "push",
      "merge",
      "deploy",
      "print secrets"
    ],
    suggestedVerificationCommands: ["original failing command"],
    humanGate: "required"
  };
}
