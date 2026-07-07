import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AdminData } from "./builder.js";
import type { AdminConfig } from "./config.js";
import { redactSecrets } from "./redaction.js";

export async function writeActionPlanReport(options: {
  out: string;
  data: AdminData;
  config: AdminConfig;
}): Promise<string> {
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderActionPlanReport(options.data, options.config), "utf8");
  return out;
}

export function renderActionPlanReport(data: AdminData, config: AdminConfig): string {
  const topRuns = data.runs.slice(0, 12);
  const lines = [
    "# RunForge Admin Action Plan",
    "",
    `Generated: ${data.generatedAt}`,
    `Config path: ${data.configPath}`,
    `Run roots: ${data.settings.defaultRoots.join(", ") || "none"}`,
    `Runs inspected: ${data.runs.length}`,
    "",
    "## Operator Queue",
    "",
    `- Runs with safe read-only actions: ${data.actionQueue.runsWithSafeReadOnlyActions}`,
    `- Runs requiring caution: ${data.actionQueue.runsRequiringCaution}`,
    `- Runs blocked by safety: ${data.actionQueue.runsBlockedBySafety}`,
    `- Runs with verified proposals: ${data.actionQueue.runsWithVerifiedProposals}`,
    `- Runs with setup failures: ${data.actionQueue.runsWithSetupFailures}`,
    `- Runs with provider rejections: ${data.actionQueue.runsWithProviderRejections}`,
    `- Runs with verification failures: ${data.actionQueue.runsWithVerificationFailures}`,
    `- Runs with mutating previews: ${data.actionQueue.runsWithMutatingPreviews}`,
    "",
    "## Top Recommended Actions",
    ""
  ];
  for (const run of topRuns) {
    const summary = data.actionSummaries[run.id];
    const actions = data.actionPreviews[run.id] ?? [];
    lines.push(`### ${run.alpha} / ${run.repo} / ${run.scenario}`);
    lines.push("");
    lines.push(`- Outcome: ${run.outcome}`);
    lines.push(`- Recommended: ${summary?.recommendedTitle ?? "No recommended action"}`);
    lines.push(`- Highest safety: ${summary?.highestSafety ?? "none"}`);
    for (const action of actions.slice(0, 4)) {
      lines.push(`- ${action.title} [${action.mode}, ${action.safety}]: ${action.rationale}`);
      if (action.command) lines.push(`  - Command: \`${redactSecrets(action.command)}\``);
      if (action.blockers?.length) lines.push(`  - Blockers: ${action.blockers.join("; ")}`);
      if (action.expectedEvidence?.length) lines.push(`  - Expected evidence: ${action.expectedEvidence.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("## Known Limitations");
  lines.push("");
  lines.push("- This report previews operator actions only; it does not execute commands, apply patches, call providers, mutate repositories, deploy, or merge.");
  lines.push("- Mutating previews are manual terminal checklists and require explicit operator approval outside the Admin UI.");
  lines.push(`- Provider references in config are rendered as references only: ${config.providers.map((provider) => `${provider.id}:${provider.apiKeyRef ?? provider.command ?? "not configured"}`).join(", ") || "none"}.`);
  return `${redactSecrets(lines.join("\n"))}\n`;
}
