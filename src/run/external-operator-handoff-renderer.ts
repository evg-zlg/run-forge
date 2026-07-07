import { join } from "node:path";
import type { OperatorHandoffPacket, OperatorHandoffResult } from "./external-operator-handoff.js";

type JsonObject = Record<string, unknown>;

export function renderOperatorHandoffSummary(result: OperatorHandoffResult): string {
  return [
    `Operator handoff packet: ${result.handoffDir}`,
    `Handoff README: ${result.readmePath}`,
    `Handoff JSON: ${result.handoffJsonPath}`,
    `Proposal patch: ${result.proposalPatchPath}`,
    `Validation: ${result.validation.passed ? "passed" : "failed"}`,
    ...(result.validation.errors.length > 0 ? result.validation.errors.map((error) => `- ${error}`) : []),
    "RunForge proposes only. Operator applies manually. Original repo must remain unchanged."
  ].join("\n");
}

export function renderHandoffReadme(handoff: OperatorHandoffPacket): string {
  return [
    "# RunForge Alpha-24 Operator Handoff Packet",
    "",
    `Trial ID: ${handoff.trialId}`,
    "",
    "RunForge proposes only.",
    "Operator applies manually.",
    "Apply only in the designated disposable/operator worktree unless explicitly approved outside RunForge.",
    "Original repo must remain unchanged.",
    "",
    "## Repo And Worktree",
    "",
    `- Source repo path: ${handoff.sourceRepo.path}`,
    `- Source HEAD before: ${handoff.sourceRepo.headBefore ?? "unknown"}`,
    `- Source HEAD after: ${handoff.sourceRepo.headAfter ?? "unknown"}`,
    `- Source status before: ${handoff.sourceRepo.statusBefore || "(clean)"}`,
    `- Source status after: ${handoff.sourceRepo.statusAfter || "(clean)"}`,
    `- Original repo mutated: ${handoff.sourceRepo.originalRepoMutated}`,
    `- Disposable/operator worktree: ${handoff.worktree.path}`,
    "",
    "## Failure",
    "",
    `- Failed command: ${handoff.failure.command}`,
    `- Failure summary: ${handoff.failure.summary}`,
    "",
    "## Proposal",
    "",
    `- Proposal outcome: ${handoff.proposal.outcome}`,
    `- Patch path: ${handoff.proposal.patchPath}`,
    `- RunForge auto-applied patch: ${handoff.proposal.autoAppliedByRunForge}`,
    `- Operator review required: ${handoff.proposal.operatorReviewRequired}`,
    "",
    "## Manual Apply",
    "",
    `See ${handoff.manualApply.instructionsPath}. The allowed target is ${handoff.manualApply.allowedTarget}. The forbidden target is ${handoff.manualApply.forbiddenTarget}.`,
    "",
    "## Validation And Rollback",
    "",
    `- Validation command: ${handoff.validation.command}`,
    `- Validation instructions: ${handoff.validation.instructionsPath}`,
    `- Rollback instructions: ${handoff.rollback.instructionsPath}`,
    "",
    "## Decisions",
    "",
    `- Accept template: ${handoff.decisionForms.accepted}`,
    `- Reject template: ${handoff.decisionForms.rejected}`,
    "Accepted evidence records manual apply to a disposable copy and passing after-validation. Rejected evidence records operator_declined and keeps the original repo unchanged.",
    "",
    "## Safety Checklist",
    "",
    `- Provider used: ${handoff.safety.providerUsed}`,
    `- Network used: ${handoff.safety.networkUsed}`,
    `- DB used: ${handoff.safety.dbUsed}`,
    `- Deploy used: ${handoff.safety.deployUsed}`,
    `- Push used: ${handoff.safety.pushUsed}`,
    `- Merge used: ${handoff.safety.mergeUsed}`,
    "",
    "## Evidence",
    "",
    `- Proposal packet: ${handoff.evidence.packetPath}`,
    `- Operator summary: ${handoff.evidence.operatorSummaryPath}`,
    `- Lifecycle report: ${handoff.evidence.lifecycleReportPath}`,
    `- Evidence links: ${handoff.evidence.evidenceLinksPath}`,
    ""
  ].join("\n");
}

export function renderApplyInstructions(handoff: OperatorHandoffPacket): string {
  return [
    "# Manual Apply Instructions",
    "",
    "RunForge proposes only. Operator applies manually. Original repo must remain unchanged.",
    "",
    "Use only the designated disposable/operator worktree:",
    "",
    "```bash",
    `cd ${shellQuote(handoff.worktree.path)}`,
    "git status --short",
    `git apply ${shellQuote(resolvePatchForShell(handoff.proposal.patchPath))}`,
    handoff.validation.command,
    "```",
    "",
    "Record the accepted decision only after the validation command passes, using `decision-form.accepted.json` as the template.",
    "Record the rejected decision with `decision-form.rejected.json` if the operator declines the proposal or validation does not pass.",
    ""
  ].join("\n");
}

export function renderValidationInstructions(handoff: OperatorHandoffPacket): string {
  return [
    "# Validation Instructions",
    "",
    "Run validation only inside the disposable/operator worktree.",
    "",
    "Before applying the patch, the command is expected to fail because this handoff exists for a failed trial.",
    "",
    "```bash",
    `cd ${shellQuote(handoff.worktree.path)}`,
    handoff.validation.command,
    "```",
    "",
    "After manually applying `proposal.patch`, rerun the same command. Expected result for acceptance: command exits successfully.",
    "",
    "Evidence should be recorded through the existing external record-decision flow and linked from the proposal packet, operator summary, lifecycle report, packet index, and dashboard seed.",
    ""
  ].join("\n");
}

export function renderRollbackInstructions(handoff: OperatorHandoffPacket): string {
  return [
    "# Rollback Notes",
    "",
    "Rollback is local to the disposable/operator worktree only. Original repo must remain unchanged.",
    "",
    "```bash",
    `cd ${shellQuote(handoff.worktree.path)}`,
    `git apply -R ${shellQuote(resolvePatchForShell(handoff.proposal.patchPath))}`,
    "git status --short",
    "```",
    "",
    "If rollback does not apply cleanly, discard the disposable/operator worktree and recreate it from the disposable source copy. Do not change the original repo as part of this handoff.",
    ""
  ].join("\n");
}

export function acceptedDecisionForm(handoff: OperatorHandoffPacket): JsonObject {
  return {
    schemaVersion: "alpha-24-operator-decision-template",
    decision: "accepted",
    finalOutcome: "accepted",
    reason: "validation_passed_after_operator_apply",
    appliedBy: "operator_manual",
    appliedTo: "disposable_copy",
    originalRepoMutated: false,
    afterValidation: "passed",
    proposalPacket: handoff.evidence.packetPath,
    proposalPatch: handoff.proposal.patchPath,
    apply: { mode: "operator_manual", appliedTo: "disposable_copy", originalRepoMutated: false },
    validation: { command: handoff.validation.command, passed: true, status: "passed" },
    runforgeAppliedPatch: false,
    safety: handoff.safety
  };
}

export function rejectedDecisionForm(handoff: OperatorHandoffPacket): JsonObject {
  return {
    schemaVersion: "alpha-24-operator-decision-template",
    decision: "rejected",
    finalOutcome: "rejected",
    reason: "operator_declined",
    originalRepoMutated: false,
    proposalPacket: handoff.evidence.packetPath,
    proposalPatch: handoff.proposal.patchPath,
    apply: { mode: "operator_declined", appliedTo: "disposable_copy", originalRepoMutated: false },
    validation: { command: handoff.validation.command, passed: false, status: "failed_or_not_run" },
    runforgeAppliedPatch: false,
    safety: handoff.safety
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolvePatchForShell(patchPath: string): string {
  return patchPath.includes("/") ? patchPath : join("..", "handoff", patchPath);
}
