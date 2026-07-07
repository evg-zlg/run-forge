import type { CommandResult, ExternalCheckStatus } from "./external-command-check-types.js";
import type { OperatorDecision } from "./external-operator-patch-trial.js";

export function commandSummaries(results: CommandResult[]): Array<{ command: string; status: string; exitCode: number | null }> {
  return results.map((result) => ({ command: result.command, status: result.status, exitCode: result.exitCode }));
}

export function renderDecisionMarkdown(record: {
  runId: string;
  proposalPacket: string;
  proposalPatch?: string;
  repo: string;
  decision: OperatorDecision;
  finalOutcome: "accepted" | "rejected";
  validation: { packet: string; status: ExternalCheckStatus; passed: boolean; commands: Array<{ command: string; status: string; exitCode: number | null }> };
  runforgeAppliedPatch: false;
  safety?: { providerUsed: false; networkUsed: false; dbUsed: false; deployUsed: false; pushUsed: false; mergeUsed: false };
  reason?: string;
  apply?: { mode: string; appliedTo: string; originalRepoMutated: false };
  repoMutationVerdictDuringDecision: string;
  notes: string;
}): string {
  return [
    "# Alpha-21 Operator Decision",
    "",
    `Run ID: ${record.runId}`,
    `Proposal packet: ${record.proposalPacket}`,
    `Proposal patch: ${record.proposalPatch ?? `${record.proposalPacket}/proposal.patch`}`,
    `Decision repo: ${record.repo}`,
    `Requested decision: ${record.decision}`,
    `Final outcome: ${record.finalOutcome}`,
    `Reason: ${record.reason || "none"}`,
    `Validation packet: ${record.validation.packet}`,
    `Validation status: ${record.validation.status}`,
    `Validation passed: ${record.validation.passed}`,
    `RunForge applied patch: ${record.runforgeAppliedPatch}`,
    `Apply mode: ${record.apply?.mode ?? "operator_simulated_manual_apply"}`,
    `Applied to: ${record.apply?.appliedTo ?? "disposable_copy"}`,
    `Original repo mutated: ${String(record.apply?.originalRepoMutated ?? false)}`,
    `Repo mutation verdict during decision rerun: ${record.repoMutationVerdictDuringDecision}`,
    `Provider used: ${record.safety?.providerUsed ?? false}`,
    `Network used: ${record.safety?.networkUsed ?? false}`,
    `DB used: ${record.safety?.dbUsed ?? false}`,
    `Push used: ${record.safety?.pushUsed ?? false}`,
    `Merge used: ${record.safety?.mergeUsed ?? false}`,
    `Deploy used: ${record.safety?.deployUsed ?? false}`,
    "",
    "## Commands",
    "",
    ...record.validation.commands.map((command) => `- ${command.command}: ${command.status} (${command.exitCode ?? "null"})`),
    "",
    "## Notes",
    "",
    record.notes || "No operator notes.",
    ""
  ].join("\n");
}
