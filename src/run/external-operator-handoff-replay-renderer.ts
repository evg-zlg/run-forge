import type { OperatorHandoffReplayResult } from "./external-operator-handoff-replay.js";

export function renderOperatorHandoffReplaySummary(result: OperatorHandoffReplayResult): string {
  return [
    `Handoff replay audit: ${result.status}`,
    `Audit report: ${result.artifacts.auditReport}`,
    `Audit result: ${result.artifacts.auditResult}`,
    `Replay worktree: ${result.replay.worktreePath}`,
    `Patch applied in replay: ${result.replay.patchApplied}`,
    `Validation: ${result.replay.validationStatus}`,
    `Original repo mutated: ${result.sourceRepo.originalRepoMutated}`,
    `Accepted decision form valid: ${result.decisionForms.acceptedValid}`,
    `Rejected decision form valid: ${result.decisionForms.rejectedValid}`,
    "Replay applies only in a disposable replay worktree.",
    "Original repo is never modified.",
    "Replay is an audit/simulation, not production apply.",
    ...(result.findings.length > 0 ? ["Findings:", ...result.findings.map((finding) => `- ${finding}`)] : [])
  ].join("\n");
}

export function renderOperatorHandoffReplayReport(result: OperatorHandoffReplayResult): string {
  return [
    "# Operator Handoff Replay Audit",
    "",
    `Audit ID: ${result.auditId}`,
    `Status: ${result.status}`,
    `Handoff path: ${result.handoffPath}`,
    "",
    "Replay applies only in a disposable replay worktree.",
    "Original repo is never modified.",
    "Replay is an audit/simulation, not production apply.",
    "",
    "## Source Repo",
    "",
    `- Path: ${result.sourceRepo.path}`,
    `- HEAD before: ${result.sourceRepo.headBefore ?? "unknown"}`,
    `- HEAD after: ${result.sourceRepo.headAfter ?? "unknown"}`,
    `- Status before: ${result.sourceRepo.statusBefore || "(clean)"}`,
    `- Status after: ${result.sourceRepo.statusAfter || "(clean)"}`,
    `- Original repo mutated: ${result.sourceRepo.originalRepoMutated}`,
    "",
    "## Replay",
    "",
    `- Worktree: ${result.replay.worktreePath}`,
    `- Patch applied: ${result.replay.patchApplied}`,
    `- Validation run: ${result.replay.validationRun}`,
    `- Validation status: ${result.replay.validationStatus}`,
    "",
    "## Decision Forms",
    "",
    `- Accepted valid: ${result.decisionForms.acceptedValid}`,
    `- Rejected valid: ${result.decisionForms.rejectedValid}`,
    "",
    "## Findings",
    "",
    ...(result.findings.length > 0 ? result.findings.map((finding) => `- ${finding}`) : ["- None"]),
    "",
    "## Recommendations",
    "",
    ...result.recommendations.map((item) => `- ${item}`),
    ""
  ].join("\n");
}
