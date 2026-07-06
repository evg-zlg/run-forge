import type { DashboardRecord } from "./dashboard-builder.js";
import { countBy, isDoNotApplyOrUnsafe, latestAlpha } from "./dashboard-record-utils.js";

export interface DashboardSummary {
  total: number;
  latestAlpha: string;
  byOutcome: Record<string, number>;
  byRepo: Record<string, number>;
  byScenario: Record<string, number>;
  byProviderStatus: Record<string, number>;
  byAlpha: Record<string, number>;
  byAlphaComparison: AlphaComparisonSummary[];
  verifiedProposals: number;
  rejectedProviderProposals: number;
  doNotApplyOrUnsafe: number;
  unchangedMutationVerdicts: number;
  reposCovered: number;
  latestVerifiedProposal: string;
  latestRejection: string;
  originalReposUnchanged: boolean;
}

export interface AlphaComparisonSummary {
  alpha: string;
  total: number;
  verifiedProposals: number;
  rejectedProviderProposals: number;
  doNotApplyOrUnsafe: number;
  unchangedMutationVerdicts: number;
  reposCovered: number;
}

export function buildSummary(records: DashboardRecord[]): DashboardSummary {
  return {
    total: records.length,
    latestAlpha: latestAlpha(records.map((record) => record.alpha)),
    byOutcome: countBy(records, (record) => record.outcome),
    byRepo: countBy(records, (record) => record.repo),
    byScenario: countBy(records, (record) => record.scenario),
    byProviderStatus: countBy(records, (record) => record.providerStatus),
    byAlpha: countBy(records, (record) => record.alpha),
    byAlphaComparison: buildAlphaComparison(records),
    verifiedProposals: records.filter((record) => record.outcome === "proposal_ready_verified").length,
    rejectedProviderProposals: records.filter(isRejectedProviderProposal).length,
    doNotApplyOrUnsafe: records.filter(isDoNotApplyOrUnsafe).length,
    unchangedMutationVerdicts: records.filter((record) => record.mutationVerdict === "unchanged").length,
    reposCovered: new Set(records.map((record) => record.repo).filter(Boolean)).size,
    latestVerifiedProposal: describeLatestRecord(records.filter((record) => record.outcome === "proposal_ready_verified")),
    latestRejection: describeLatestRecord(records.filter(isRejectedProviderProposal)),
    originalReposUnchanged: records.length > 0 && records.every((record) => record.mutationVerdict === "unchanged")
  };
}

function buildAlphaComparison(records: DashboardRecord[]): AlphaComparisonSummary[] {
  return [...new Set(records.map((record) => record.alpha).filter(Boolean))].sort().map((alpha) => {
    const alphaRecords = records.filter((record) => record.alpha === alpha);
    return {
      alpha,
      total: alphaRecords.length,
      verifiedProposals: alphaRecords.filter((record) => record.outcome === "proposal_ready_verified").length,
      rejectedProviderProposals: alphaRecords.filter(isRejectedProviderProposal).length,
      doNotApplyOrUnsafe: alphaRecords.filter(isDoNotApplyOrUnsafe).length,
      unchangedMutationVerdicts: alphaRecords.filter((record) => record.mutationVerdict === "unchanged").length,
      reposCovered: new Set(alphaRecords.map((record) => record.repo).filter(Boolean)).size
    };
  });
}

function describeLatestRecord(records: DashboardRecord[]): string {
  const alpha = latestAlpha(records.map((record) => record.alpha));
  const record = records.find((candidate) => candidate.alpha === alpha) ?? records.at(-1);
  if (!record) return "none";
  return `${record.alpha} / ${record.repo} / ${record.scenario}`;
}

function isRejectedProviderProposal(record: DashboardRecord): boolean {
  return record.outcome === "provider_rejected" || record.providerStatus === "rejected";
}
