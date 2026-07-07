import type { PacketIndexResult } from "./packet-indexer.js";

export function renderPacketIndexMarkdown(index: PacketIndexResult): string {
  const lines = [
    "# RunForge Packet Index",
    "",
    `Generated at: ${index.generatedAt}`,
    `Root: ${index.root}`,
    "",
    "| Milestone | Scenario | Packet type | Outcome | Decision | Validation | Applied to | Auto-apply | Mutation | Patch | Packet | Viewer |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const entry of index.entries) {
    lines.push([
      entry.milestone,
      entry.scenario,
      entry.packetType,
      entry.outcome,
      entry.decision,
      `${entry.validationBefore}->${entry.validationAfter}`,
      entry.decisionAppliedTo,
      entry.autoAppliedByRunForge === null ? "unknown" : String(entry.autoAppliedByRunForge),
      entry.externalRepoMutationVerdict,
      entry.proposalPatchPath,
      entry.packetPath,
      entry.viewerPath
    ].map(markdownCell).join(" | "));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderPacketIndexText(index: PacketIndexResult): string {
  return [
    `Indexed ${index.entries.length} packet/run entries under ${index.root}.`,
    ...index.entries.map((entry) => `${entry.milestone} ${entry.scenario}: ${entry.outcome} decision=${entry.decision} validation=${entry.validationBefore}->${entry.validationAfter} mutation=${entry.externalRepoMutationVerdict}`)
  ].join("\n");
}

function markdownCell(value: string): string {
  return ` ${value.replaceAll("|", "\\|")} `;
}
