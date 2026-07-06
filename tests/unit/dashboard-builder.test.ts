import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStaticDashboard } from "../../src/run/dashboard-builder.js";

describe("static dashboard builder", () => {
  it("builds index.html and dashboard-data.json from a valid seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-dashboard-"));
    const seedPath = join(root, "dashboard-seed.json");
    const out = join(root, "dashboard");
    await writeSeed(seedPath);

    const result = await buildStaticDashboard({ seed: seedPath, out });
    const html = await readFile(join(out, "index.html"), "utf8");
    const data = JSON.parse(await readFile(join(out, "dashboard-data.json"), "utf8")) as {
      schemaVersion: string;
      sourceSeedPath: string;
      summary: {
        total: number;
        latestAlpha: string;
        verifiedProposals: number;
        rejectedProviderProposals: number;
        doNotApplyOrUnsafe: number;
        unchangedMutationVerdicts: number;
        reposCovered: number;
        latestVerifiedProposal: string;
        latestRejection: string;
        byOutcome: Record<string, number>;
        byRepo: Record<string, number>;
        byScenario: Record<string, number>;
        byAlphaComparison: unknown[];
      };
      records: Array<{ outcome: string; operatorVerdict: string; safetyLabels: string[] }>;
    };

    expect(result.indexPath).toBe(join(out, "index.html"));
    expect(html).toContain("Total records");
    expect(html).toContain('id="dashboard-search"');
    expect(html).toContain('id="outcome-filter"');
    expect(html).toContain('id="repo-filter"');
    expect(html).toContain('id="provider-status-filter"');
    expect(html).toContain('id="mutation-verdict-filter"');
    expect(html).toContain('id="alpha-filter"');
    expect(html).toContain('id="reset-filters"');
    expect(html).toContain('id="copy-current-view"');
    expect(html).toContain('id="current-view-url"');
    expect(html).toContain('data-quick-filter="verified"');
    expect(html).toContain('data-quick-filter="unsafe"');
    expect(html).toContain("Show only verified proposals");
    expect(html).toContain("Show only unsafe/do_not_apply");
    expect(html).toContain("readStateFromHash");
    expect(html).toContain("window.location.hash");
    expect(html).toContain("URLSearchParams");
    expect(html).toContain("history.pushState");
    expect(html).toContain("Reset filters");
    expect(html).toContain("By repo");
    expect(html).toContain("By scenario");
    expect(html).toContain("By outcome");
    expect(html).toContain("By alpha / milestone");
    expect(html).toContain("Alpha comparison");
    expect(html).toContain('data-filter-key="repo"');
    expect(html).toContain('data-filter-key="outcome"');
    expect(html).toContain('data-filter-key="alpha"');
    expect(html).toContain('data-sort="alpha"');
    expect(html).toContain('data-sort="repo"');
    expect(html).toContain("No records match the active filters");
    expect(html).toContain("proposal_ready_verified");
    expect(html).toContain("provider_rejected");
    expect(html).toContain("Provider status");
    expect(html).toContain("Operator verdict");
    expect(html).toContain("DO NOT APPLY");
    expect(html).toContain("Reason:");
    expect(html).toContain("do_not_apply");
    expect(html).toContain("forbidden_path");
    expect(html).toContain("Evidence drilldown");
    expect(html).toContain("<details>");
    expect(html).toContain("/tmp/runforge/packet");
    expect(html).toContain("/tmp/runforge/viewer/index.html");
    expect(html).toContain("/tmp/runforge/summary.md");
    expect(html).toContain("/tmp/runforge/proposal.patch");
    expect(html).toContain("/tmp/runforge/human-review.md");
    expect(html).not.toContain("<script src=");
    expect(data.schemaVersion).toBe("alpha-12-dashboard");
    expect(data.sourceSeedPath).toBe(seedPath);
    expect(data.summary).toMatchObject({
      total: 3,
      latestAlpha: "ALPHA-12",
      verifiedProposals: 1,
      rejectedProviderProposals: 1,
      doNotApplyOrUnsafe: 1,
      unchangedMutationVerdicts: 3,
      reposCovered: 2,
      latestVerifiedProposal: "ALPHA-12 / smartsql / merge_intervals",
      latestRejection: "ALPHA-12 / smartsql / forbidden_path"
    });
    expect(data.summary.byOutcome.provider_rejected).toBe(1);
    expect(data.summary.byRepo.smartsql).toBe(2);
    expect(data.summary.byScenario.merge_intervals).toBe(1);
    expect(data.summary.byAlphaComparison).toHaveLength(2);
    expect(data.records.some((record) => record.outcome === "proposal_ready_verified")).toBe(true);
    expect(data.records.some((record) => record.operatorVerdict === "do_not_apply")).toBe(true);
    expect(data.records.flatMap((record) => record.safetyLabels)).toContain("provider_rejected");
    expect(data.records.flatMap((record) => record.safetyLabels)).toContain("do_not_apply");
  });

  it("fails clearly on a missing seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-dashboard-missing-"));
    await expect(buildStaticDashboard({
      seed: join(root, "missing-dashboard-seed.json"),
      out: join(root, "dashboard")
    })).rejects.toThrow("Unable to read dashboard seed");
  });

  it("fails clearly on an invalid seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-dashboard-invalid-"));
    const seedPath = join(root, "dashboard-seed.json");
    await mkdir(root, { recursive: true });
    await writeFile(seedPath, JSON.stringify({ schemaVersion: "wrong", records: [] }), "utf8");

    await expect(buildStaticDashboard({
      seed: seedPath,
      out: join(root, "dashboard")
    })).rejects.toThrow("Invalid dashboard seed");
  });
});

async function writeSeed(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({
    schemaVersion: "alpha-11-dashboard-seed",
    generatedAt: "2026-07-05T00:00:00.000Z",
    summary: {
      total: 3,
      byOutcome: {
        proposal_ready_verified: 1,
        provider_rejected: 1,
        verification_failed: 1
      },
      byRepo: {
        smartsql: 2,
        deskbuilder: 1
      },
      byProviderStatus: {
        accepted: 2,
        rejected: 1
      }
    },
    records: [
      record({
        id: "ALPHA-12:verified",
        alpha: "ALPHA-12",
        repo: "smartsql",
        scenario: "merge_intervals",
        outcome: "proposal_ready_verified",
        providerStatus: "accepted",
        operatorVerdict: "no_apply",
        mutationVerdict: "unchanged",
        tags: ["proposal_ready_verified"]
      }),
      record({
        id: "ALPHA-12:rejected",
        alpha: "ALPHA-12",
        repo: "smartsql",
        scenario: "forbidden_path",
        outcome: "provider_rejected",
        providerStatus: "rejected",
        operatorVerdict: "do_not_apply",
        mutationVerdict: "unchanged",
        tags: ["provider:rejected", "forbidden"]
      }),
      record({
        id: "ALPHA-11:failed",
        alpha: "ALPHA-11",
        repo: "deskbuilder",
        scenario: "verification",
        outcome: "verification_failed",
        providerStatus: "accepted",
        operatorVerdict: "comparison_only",
        mutationVerdict: "unchanged",
        tags: ["verification_failed"]
      })
    ]
  }, null, 2), "utf8");
}

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    packetType: "external_code_proposal",
    packetPath: "/tmp/runforge/packet",
    viewerPath: "/tmp/runforge/viewer/index.html",
    summaryPath: "/tmp/runforge/summary.md",
    validationEvidencePath: "/tmp/runforge/validation.md",
    providerAuditPath: "/tmp/runforge/provider-safety-report.json",
    proposalPatchPath: "/tmp/runforge/proposal.patch",
    humanReviewPath: "/tmp/runforge/human-review.md",
    notes: "dashboard fixture",
    ...overrides
  };
}
