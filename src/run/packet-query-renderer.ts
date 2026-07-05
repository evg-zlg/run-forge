import type {
  LatestDogfoodResult,
  PacketQueryFilters,
  PacketQueryFormat,
  PacketQueryRecord,
  PacketQueryResult
} from "./packet-query.js";

export function renderPacketQuery(result: PacketQueryResult, format: PacketQueryFormat = "table"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "md") return renderPacketQueryMarkdown(result);
  return renderPacketQueryTable(result);
}

export function renderPacketQueryMarkdown(result: PacketQueryResult): string {
  const lines = [
    "# RunForge Packet Query",
    "",
    `Generated at: ${result.generatedAt}`,
    `Index: ${result.indexPath}`,
    `Matching count: ${result.matchingCount}`,
    "",
    "## Filters",
    ""
  ];
  const filterEntries = Object.entries(result.filters);
  if (filterEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [key, value] of filterEntries) lines.push(`- ${key}: ${value}`);
  }
  lines.push("", "## Matches", "");
  if (result.records.length === 0) {
    lines.push("No packet evidence matched the supplied filters.");
  } else {
    lines.push("| Alpha | Scenario | Repo | Outcome | Provider | Mutation | Operator verdict | Packet | Viewer | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const record of result.records) {
      lines.push([
        record.alpha,
        record.scenario,
        record.repo,
        record.outcome,
        record.providerStatus,
        record.mutationVerdict,
        record.operatorVerdict,
        record.packetPath,
        record.viewerPath,
        record.notes
      ].map(markdownCell).join(" | "));
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderLatestDogfoodMarkdown(result: LatestDogfoodResult): string {
  const lines = [
    "# RunForge Latest Dogfood Evidence",
    "",
    `Generated at: ${result.generatedAt}`,
    `Root: ${result.root}`,
    `Latest alpha: ${result.latestAlpha}`,
    `Indexed dogfood cases: ${result.dogfoodCaseCount}`,
    `Original repos stayed unchanged: ${result.originalReposStayedUnchanged ? "yes" : "no"}`,
    "",
    "## Counts",
    "",
    renderCounts("Outcome", result.counts.byOutcome),
    "",
    renderCounts("Provider status", result.counts.byProviderStatus),
    "",
    renderCounts("Mutation verdict", result.counts.byMutationVerdict),
    "",
    "## Repos Tested",
    "",
    ...(result.reposTested.length > 0 ? result.reposTested.map((repo) => `- ${repo}`) : ["- none"]),
    "",
    "## Latest Verified Proposal",
    "",
    renderMaybeRecord(result.latestVerifiedProposal),
    "",
    "## Latest Provider Rejection",
    "",
    renderMaybeRecord(result.latestProviderRejection),
    "",
    "## Failed Or Unsafe Proposals",
    ""
  ];
  if (result.failedOrUnsafeProposals.length === 0) {
    lines.push("- none");
  } else {
    for (const record of result.failedOrUnsafeProposals) lines.push(`- ${record.alpha} ${record.scenario}: ${record.outcome}, provider=${record.providerStatus}, packet=${record.packetPath}, viewer=${record.viewerPath}`);
  }
  lines.push("", "## Artifacts", "");
  for (const artifact of result.artifacts) {
    lines.push(`- ${artifact.alpha} ${artifact.scenario}: packet=${artifact.packetPath}; viewer=${artifact.viewerPath}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderPacketQueryTable(result: PacketQueryResult): string {
  const lines = [
    `Matching count: ${result.matchingCount}`,
    `Filters: ${formatFilters(result.filters)}`
  ];
  if (result.records.length === 0) {
    lines.push("No packet evidence matched the supplied filters.");
    return lines.join("\n");
  }
  lines.push("Alpha | Scenario | Repo | Outcome | Provider | Mutation | Operator verdict");
  for (const record of result.records) {
    lines.push(`${record.alpha} | ${record.scenario} | ${record.repo} | ${record.outcome} | ${record.providerStatus} | ${record.mutationVerdict} | ${record.operatorVerdict}`);
    lines.push(`  packet: ${record.packetPath}`);
    lines.push(`  viewer: ${record.viewerPath}`);
    if (record.notes) lines.push(`  notes: ${record.notes}`);
  }
  return lines.join("\n");
}

function renderCounts(label: string, counts: Record<string, number>): string {
  const lines = [`### ${label}`, ""];
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    lines.push("- none");
  } else {
    for (const [key, value] of entries) lines.push(`- ${key}: ${value}`);
  }
  return lines.join("\n");
}

function renderMaybeRecord(record: PacketQueryRecord | null): string {
  if (!record) return "- none";
  return [
    `- ${record.alpha} ${record.scenario}: ${record.outcome}`,
    `- repo: ${record.repo}`,
    `- provider status: ${record.providerStatus}`,
    `- mutation verdict: ${record.mutationVerdict}`,
    `- operator verdict: ${record.operatorVerdict}`,
    `- packet: ${record.packetPath}`,
    `- viewer: ${record.viewerPath}`,
    record.notes ? `- notes: ${record.notes}` : ""
  ].filter(Boolean).join("\n");
}

function formatFilters(filters: PacketQueryFilters): string {
  const entries = Object.entries(filters);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function markdownCell(value: string): string {
  return ` ${value.replaceAll("|", "\\|").replaceAll("\n", " ")} `;
}
