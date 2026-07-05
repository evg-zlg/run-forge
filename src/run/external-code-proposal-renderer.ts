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
  diagnostics: string[];
}

interface OperatorVerdict {
  status: "ready_for_human_review" | "do_not_apply";
  reason: string;
  failureClass: string;
  nextAction: string;
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
  const verdict = operatorVerdict(input.outcome, input.packetOverview);
  return `# Code Proposal

Run ID: ${input.runId}

Outcome: ${input.outcome}

Operator verdict: ${verdict.status}

Failure class: ${verdict.failureClass}

Reason: ${verdict.reason}

Next action: ${verdict.nextAction}

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
  const verdict = operatorVerdict(outcome, overview);
  return `# Human Review

Outcome: ${outcome}

Operator verdict: ${verdict.status}

Failure class: ${verdict.failureClass}

Reason: ${verdict.reason}

Next action: ${verdict.nextAction}

Reviewer decision: ${overview.reviewerDecision}

Strategy: ${overview.strategy ?? "none"}

Files that would change:
${overview.filesChanged.length > 0 ? overview.filesChanged.map((file) => `- ${file}`).join("\n") : "- No files changed."}

Verification commands:
${overview.verificationCommands.length > 0 ? overview.verificationCommands.map((command) => `- ${command}`).join("\n") : "- No verification commands ran."}

- proposal.patch was not applied to the original repository.
- Verification, when present, ran only in a disposable workspace.
- Human gate: required.
- ${verdict.status === "ready_for_human_review" ? "Apply only after a human independently accepts the packet evidence and patch." : "Do not apply proposal.patch from this packet."}
`;
}

export function renderPatchSummary(proposal: DeterministicCodeProposal | null, outcome: CodeProposalOutcome, diagnostics: string[], overview: PacketOverview): string {
  const verdict = operatorVerdict(outcome, { ...overview, diagnostics });
  return `# Patch Summary

Outcome: ${outcome}

Operator verdict: ${verdict.status}

Failure class: ${verdict.failureClass}

Reason: ${verdict.reason}

Next action: ${verdict.nextAction}

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

export function operatorVerdict(outcome: CodeProposalOutcome, overview: PacketOverview): OperatorVerdict {
  if (outcome === "proposal_ready_verified") {
    return {
      status: "ready_for_human_review",
      reason: "Patch is verified in a disposable workspace and still requires a human gate.",
      failureClass: "none",
      nextAction: "Review proposal.patch and packet evidence before any manual apply."
    };
  }

  const reason = explicitReason(overview);
  return {
    status: "do_not_apply",
    reason,
    failureClass: failureClassFor(outcome, overview),
    nextAction: nextActionFor(outcome, reason)
  };
}

function explicitReason(overview: PacketOverview): string {
  if (overview.diagnostics.length > 0) return overview.diagnostics.join("; ");
  if (overview.reviewerReason && overview.reviewerReason !== "Reviewer did not run.") return overview.reviewerReason;
  return "Packet outcome is not proposal_ready_verified.";
}

function failureClassFor(outcome: CodeProposalOutcome, overview: PacketOverview): string {
  const text = `${outcome}\n${overview.diagnostics.join("\n")}\n${overview.reviewerReason}`.toLowerCase();
  if (text.includes("malformed diff") || text.includes("hunk")) return "malformed_diff";
  if (text.includes("dry-run apply") || text.includes("did not apply") || text.includes("could not be applied")) return "dry_run_apply_failed";
  if (text.includes("forbidden path") || text.includes("outside allowedpaths") || text.includes("outside repo scope")) return "forbidden_path";
  if (outcome === "verification_failed" || text.includes("verification")) return "verification_failed";
  if (outcome === "not_ready") return "not_ready";
  if (outcome === "no_safe_proposal") return "no_safe_proposal";
  if (outcome === "provider_rejected") return "provider_rejected";
  if (outcome === "provider_failed") return "provider_failed";
  if (outcome === "blocked_by_safety") return "blocked_by_safety";
  return "not_ready";
}

function nextActionFor(outcome: CodeProposalOutcome, reason: string): string {
  const text = reason.toLowerCase();
  if (text.includes("malformed diff") || text.includes("hunk")) return "Ask the provider to emit a valid unified diff, then rerun RunForge.";
  if (text.includes("dry-run apply") || text.includes("did not apply") || text.includes("could not be applied")) return "Regenerate the patch against the current repo state; do not hand-apply this patch.";
  if (text.includes("forbidden path") || text.includes("outside allowedpaths") || text.includes("outside repo scope")) return "Constrain the provider to allowed files or change the safety contract intentionally, then rerun.";
  if (outcome === "verification_failed") return "Inspect verification-results.json and fix the proposal before creating a new packet.";
  if (outcome === "not_ready") return "Collect missing readiness evidence before attempting a code proposal.";
  if (outcome === "no_safe_proposal") return "Provide more failure context or add a deterministic/provider proposal path.";
  if (outcome === "provider_failed") return "Fix the provider command/output contract, then rerun.";
  return "Treat this packet as rejected evidence and rerun after correcting the cause.";
}
