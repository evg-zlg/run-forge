import { join, resolve } from "node:path";
import { redactJson, redactSecrets } from "./redaction.js";
import type { AdminRunRecord } from "./run-records.js";
import type { AdminRunDetail } from "./run-graph.js";

export type AdminActionCategory = "inspect" | "validate" | "demo" | "setup" | "provider" | "proposal" | "apply" | "merge" | "cleanup" | "custom";
export type AdminActionMode = "read_only" | "dry_run" | "mutating" | "blocked";
export type AdminActionSafety = "safe" | "caution" | "danger" | "blocked";
export type AdminActionSource = "packet" | "run_detail" | "setup_policy" | "provider_audit" | "proposal_readiness" | "validation" | "admin_config" | "heuristic";

export interface AdminActionPreview {
  id: string;
  title: string;
  category: AdminActionCategory;
  mode: AdminActionMode;
  safety: AdminActionSafety;
  source: AdminActionSource;
  command?: string;
  workingDirectory?: string;
  reads?: string[];
  writes?: string[];
  expectedEvidence?: string[];
  preconditions?: string[];
  blockers?: string[];
  warnings?: string[];
  rationale: string;
  copyLabel?: string;
}

export interface AdminActionRunSummary {
  count: number;
  safeCount: number;
  cautionCount: number;
  dangerCount: number;
  blockedCount: number;
  mutatingCount: number;
  highestSafety: AdminActionSafety | "none";
  recommendedTitle: string;
  hasRecommendedAction: boolean;
  hasSafeAction: boolean;
  hasCautionAction: boolean;
  hasBlockedAction: boolean;
  hasMutatingPreview: boolean;
}

export interface AdminActionQueueSummary {
  runsWithSafeReadOnlyActions: number;
  runsRequiringCaution: number;
  runsBlockedBySafety: number;
  runsWithVerifiedProposals: number;
  runsWithSetupFailures: number;
  runsWithProviderRejections: number;
  runsWithVerificationFailures: number;
  runsWithMutatingPreviews: number;
  runsWithNoRecommendedAction: number;
}

const SAFETY_RANK: Record<AdminActionSafety, number> = {
  safe: 1,
  caution: 2,
  danger: 3,
  blocked: 4
};

export function buildActionPreviews(run: AdminRunRecord, detail?: AdminRunDetail): AdminActionPreview[] {
  const actions: AdminActionPreview[] = [];
  const reads = importantReads(run, detail);
  const repoPath = run.repoPath && run.repoPath !== "unknown" ? run.repoPath : undefined;

  actions.push({
    id: `${run.id}:inspect`,
    title: "Inspect run evidence",
    category: "inspect",
    mode: "read_only",
    safety: "safe",
    source: "packet",
    command: run.packetPath !== "unknown" ? `pnpm dev packet inspect --packet ${quote(run.packetPath)}` : undefined,
    workingDirectory: repoPath,
    reads,
    expectedEvidence: reads,
    rationale: "Start with packet evidence before deciding whether any provider output, setup fix, or manual validation step is appropriate.",
    copyLabel: "Copy inspect command"
  });

  if (run.hasViewer) {
    actions.push({
      id: `${run.id}:viewer`,
      title: "Open packet viewer",
      category: "inspect",
      mode: "read_only",
      safety: "safe",
      source: "run_detail",
      command: run.viewerPath !== "unknown" ? `open ${quote(run.viewerPath)}` : undefined,
      workingDirectory: repoPath,
      reads: [run.viewerPath],
      expectedEvidence: [run.viewerPath],
      rationale: "The run already has a generated viewer artifact; opening it is a local read-only inspection step.",
      copyLabel: "Copy open command"
    });
  }

  if (run.setupFailure) {
    actions.push({
      id: `${run.id}:setup-policy`,
      title: "Inspect setup failure policy",
      category: "setup",
      mode: "read_only",
      safety: "caution",
      source: "setup_policy",
      command: run.packetPath !== "unknown" ? `pnpm dev packet inspect --packet ${quote(run.packetPath)} --validate` : undefined,
      workingDirectory: repoPath,
      reads,
      expectedEvidence: [join(run.packetPath, "setup-policy.json"), run.eventsPath].filter((path) => path !== "unknown"),
      warnings: ["Setup failed earlier; inspect policy and events before rerunning validation."],
      rationale: "Setup failures can make downstream validation misleading, so the next safe step is to inspect policy and event evidence.",
      copyLabel: "Copy validation command"
    });
  }

  if (run.providerRejected) {
    actions.push({
      id: `${run.id}:provider-rejection`,
      title: "Do not apply provider output",
      category: "provider",
      mode: "blocked",
      safety: "blocked",
      source: "provider_audit",
      reads: [run.providerAuditPath, run.packetPath].filter((path) => path !== "unknown"),
      blockers: ["Provider audit rejected the output.", "Manual apply and merge previews are blocked for this run."],
      expectedEvidence: [run.providerAuditPath].filter((path) => path !== "unknown"),
      rationale: "Rejected provider output should be treated as diagnostic evidence only; deterministic validation or manual inspection may continue.",
      copyLabel: "Blocked"
    });
  }

  if (run.verificationFailed) {
    actions.push({
      id: `${run.id}:verification-failed`,
      title: "Inspect verifier failure before applying",
      category: "validate",
      mode: "blocked",
      safety: "blocked",
      source: "validation",
      reads: [run.eventsPath, run.metricsPath, run.safetyReportPath].filter((path) => path !== "unknown"),
      blockers: ["Verification failed for this run.", "Patch/proposal apply is blocked until validation passes after a manual fix."],
      expectedEvidence: [run.eventsPath, run.metricsPath].filter((path) => path !== "unknown"),
      rationale: "A failed verifier means the proposed change is not ready for application, even if a proposal artifact exists.",
      copyLabel: "Blocked"
    });
  }

  if (run.doNotApply) {
    actions.push({
      id: `${run.id}:do-not-apply`,
      title: "Respect do_not_apply verdict",
      category: "apply",
      mode: "blocked",
      safety: "blocked",
      source: "proposal_readiness",
      reads: [run.safetyReportPath, run.providerAuditPath, run.packetPath].filter((path) => path !== "unknown"),
      blockers: ["Operator or safety verdict is do_not_apply.", "No apply or merge command is recommended."],
      warnings: ["Use copyable diagnostic commands only for this run."],
      rationale: "The UI must not encourage mutation when the packet or reviewer verdict says the proposal should not be applied."
    });
  }

  if (run.verifiedProposal && !run.doNotApply && !run.providerRejected && !run.verificationFailed) {
    actions.push({
      id: `${run.id}:manual-apply`,
      title: "Manual proposal apply readiness check",
      category: "apply",
      mode: "mutating",
      safety: "danger",
      source: "proposal_readiness",
      command: run.packetPath !== "unknown" ? `pnpm dev packet inspect --packet ${quote(run.packetPath)} --validate` : undefined,
      workingDirectory: repoPath,
      reads,
      writes: ["external repository worktree if an operator later applies the proposal manually"],
      expectedEvidence: [run.safetyReportPath, run.providerAuditPath, run.eventsPath].filter((path) => path !== "unknown"),
      preconditions: [
        "Clean target worktree",
        "Correct branch selected in a terminal",
        "CI or local validation passes",
        "No do_not_apply verdict",
        "Explicit operator approval"
      ],
      warnings: ["This UI does not apply patches. Treat this as a readiness checklist, not an execution button."],
      rationale: "A verified proposal can be considered for a separate manual terminal workflow, but only after checking all preconditions.",
      copyLabel: "Copy diagnostic command"
    });
  }

  if (!run.doNotApply && !run.providerRejected) {
    actions.push({
      id: `${run.id}:rerun-packet-validation`,
      title: "Rerun packet validation",
      category: "validate",
      mode: "dry_run",
      safety: run.verificationFailed || run.setupFailure ? "caution" : "safe",
      source: "validation",
      command: "pnpm validation:packets",
      workingDirectory: resolve("."),
      reads: ["validation/runs", "schemas"],
      writes: ["validation/runs/PACKET-VALIDATION"],
      expectedEvidence: ["validation/runs/PACKET-VALIDATION/results.json", "validation/runs/PACKET-VALIDATION/summary.md"],
      warnings: run.verificationFailed || run.setupFailure ? ["Validation may still fail until the underlying issue is fixed manually."] : undefined,
      rationale: "Packet validation is an established local validation command and does not call paid providers by default.",
      copyLabel: "Copy validation command"
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: `${run.id}:manual-inspection`,
      title: "Manual inspection required",
      category: "custom",
      mode: "read_only",
      safety: "caution",
      source: "heuristic",
      reads,
      warnings: ["Exact next command could not be inferred safely from packet metadata."],
      rationale: "RunForge could not infer a specific supported command without risking a fake or unsafe preview."
    });
  }

  return redactJson(actions.map(normalizeAction));
}

export function summarizeActionPreviews(actions: AdminActionPreview[]): AdminActionRunSummary {
  const highest = actions.reduce<AdminActionSafety | "none">((current, action) => {
    if (current === "none") return action.safety;
    return SAFETY_RANK[action.safety] > SAFETY_RANK[current] ? action.safety : current;
  }, "none");
  const recommended = actions.find((action) => action.mode !== "blocked") ?? actions[0];
  return {
    count: actions.length,
    safeCount: actions.filter((action) => action.safety === "safe").length,
    cautionCount: actions.filter((action) => action.safety === "caution").length,
    dangerCount: actions.filter((action) => action.safety === "danger").length,
    blockedCount: actions.filter((action) => action.safety === "blocked" || action.mode === "blocked").length,
    mutatingCount: actions.filter((action) => action.mode === "mutating").length,
    highestSafety: highest,
    recommendedTitle: recommended?.title ?? "No recommended action",
    hasRecommendedAction: Boolean(recommended && recommended.mode !== "blocked"),
    hasSafeAction: actions.some((action) => action.safety === "safe"),
    hasCautionAction: actions.some((action) => action.safety === "caution"),
    hasBlockedAction: actions.some((action) => action.safety === "blocked" || action.mode === "blocked"),
    hasMutatingPreview: actions.some((action) => action.mode === "mutating")
  };
}

export function buildActionQueueSummary(runs: AdminRunRecord[], summaries: Record<string, AdminActionRunSummary>): AdminActionQueueSummary {
  return {
    runsWithSafeReadOnlyActions: runs.filter((run) => (summaries[run.id]?.safeCount ?? 0) > 0).length,
    runsRequiringCaution: runs.filter((run) => (summaries[run.id]?.cautionCount ?? 0) > 0 || (summaries[run.id]?.dangerCount ?? 0) > 0).length,
    runsBlockedBySafety: runs.filter((run) => summaries[run.id]?.hasBlockedAction).length,
    runsWithVerifiedProposals: runs.filter((run) => run.verifiedProposal).length,
    runsWithSetupFailures: runs.filter((run) => run.setupFailure).length,
    runsWithProviderRejections: runs.filter((run) => run.providerRejected).length,
    runsWithVerificationFailures: runs.filter((run) => run.verificationFailed).length,
    runsWithMutatingPreviews: runs.filter((run) => summaries[run.id]?.hasMutatingPreview).length,
    runsWithNoRecommendedAction: runs.filter((run) => summaries[run.id]?.hasRecommendedAction === false).length
  };
}

function importantReads(run: AdminRunRecord, detail?: AdminRunDetail): string[] {
  const paths = [
    run.packetPath,
    run.summaryPath,
    run.eventsPath,
    run.metricsPath,
    run.safetyReportPath,
    run.providerAuditPath,
    detail?.packetPath
  ].filter((path): path is string => Boolean(path) && path !== "unknown");
  return [...new Set(paths)];
}

function normalizeAction(action: AdminActionPreview): AdminActionPreview {
  const normalized = {
    ...action,
    command: action.command ? redactSecrets(action.command) : undefined,
    workingDirectory: action.workingDirectory ? redactSecrets(action.workingDirectory) : undefined,
    reads: cleanList(action.reads),
    writes: cleanList(action.writes),
    expectedEvidence: cleanList(action.expectedEvidence),
    preconditions: cleanList(action.preconditions),
    blockers: cleanList(action.blockers),
    warnings: cleanList(action.warnings)
  };
  if (normalized.mode === "blocked" && normalized.command) {
    normalized.warnings = [...(normalized.warnings ?? []), "Command is shown only for context and is not recommended."];
  }
  if (normalized.mode === "mutating") {
    normalized.warnings = [...(normalized.warnings ?? []), "Manual terminal command only. The Admin UI never executes this action."];
  }
  return normalized;
}

function cleanList(values: string[] | undefined): string[] | undefined {
  const cleaned = [...new Set((values ?? []).filter(Boolean).map(redactSecrets))];
  return cleaned.length ? cleaned : undefined;
}

function quote(value: string): string {
  return `'${redactSecrets(value).replaceAll("'", "'\\''")}'`;
}
