import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPacketIndex, renderPacketIndexMarkdown } from "../../src/run/packet-indexer.js";
import {
  buildDashboardSeed,
  buildLatestDogfoodReport,
  queryPacketIndex
} from "../../src/run/packet-query.js";
import { renderPacketQuery } from "../../src/run/packet-query-renderer.js";

describe("packet indexer", () => {
  it("indexes dogfood index entries and writes markdown/json outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-packet-index-"));
    const alpha10 = join(root, "ALPHA-10");
    const out = join(root, "out");
    await mkdir(alpha10, { recursive: true });
    await writeFile(join(alpha10, "external-dogfood-index.json"), JSON.stringify({
      entries: [{
        repo: "/repo",
        scenario: "provider-reject",
        outcome: "provider_rejected",
        providerStatus: "rejected",
        patchTouchedFiles: [],
        packetPath: "/tmp/provider/packet",
        viewerPath: "/tmp/provider/viewer/index.html",
        externalRepoHeadBefore: "abc",
        externalRepoHeadAfter: "abc",
        externalRepoMutationVerdict: "unchanged",
        decision: "comparison_only",
        notes: "patch failed dry-run apply"
      }]
    }), "utf8");

    const index = await buildPacketIndex({ root, out });

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      milestone: "ALPHA-10",
      scenario: "provider-reject",
      outcome: "provider_rejected",
      providerStatus: "rejected",
      externalRepoMutationVerdict: "unchanged"
    });
    expect(await readFile(join(out, "index.json"), "utf8")).toContain("provider-reject");
    expect(await readFile(join(out, "index.md"), "utf8")).toContain("provider_rejected");
  });

  it("indexes Alpha-9 results attempts without requiring copied packet trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-packet-index-results-"));
    const alpha9 = join(root, "ALPHA-9");
    await mkdir(alpha9, { recursive: true });
    await writeFile(join(alpha9, "results.json"), JSON.stringify({
      externalRepo: {
        beforeHead: "abc",
        afterHead: "abc",
        mutationVerdict: "unchanged"
      },
      attempts: [{
        id: "smartsql-provider-reject",
        repo: "/Users/example/smartsql",
        decision: "provider_rejected",
        packet: "/tmp/runforge-alpha9/packet",
        viewer: "/tmp/runforge-alpha9/viewer/index.html",
        outcome: "provider_rejected",
        providerStatus: "rejected",
        filesChanged: [],
        manualApply: false
      }]
    }), "utf8");

    const index = await buildPacketIndex({ root });
    const markdown = renderPacketIndexMarkdown(index);

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].milestone).toBe("ALPHA-9");
    expect(index.entries[0].decision).toBe("provider_rejected");
    expect(index.entries[0].externalRepoMutationVerdict).toBe("unchanged");
    expect(markdown).toContain("smartsql-provider-reject");
  });

  it("queries packet indexes with filters and renders clear empty output", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-packet-query-"));
    const alpha11 = join(root, "ALPHA-11");
    const indexOut = join(root, "index");
    const queryOut = join(root, "query");
    await mkdir(alpha11, { recursive: true });
    await writeFile(join(alpha11, "external-dogfood-index.json"), JSON.stringify({
      entries: [
        {
          repo: "/Users/example/smartsql",
          scenario: "merge_intervals",
          outcome: "proposal_ready_verified",
          providerStatus: "accepted",
          packetPath: "/tmp/accepted/packet",
          viewerPath: "/tmp/accepted/viewer/index.html",
          externalRepoMutationVerdict: "unchanged",
          decision: "no_apply",
          notes: "verified without mutating original repo"
        },
        {
          repo: "/Users/example/smartsql",
          scenario: "env_reject",
          outcome: "provider_rejected",
          providerStatus: "rejected",
          packetPath: "/tmp/rejected/packet",
          viewerPath: "/tmp/rejected/viewer/index.html",
          externalRepoMutationVerdict: "unchanged",
          decision: "do_not_apply",
          notes: "forbidden path"
        }
      ]
    }), "utf8");

    await buildPacketIndex({ root, out: indexOut });
    const query = await queryPacketIndex({
      index: join(indexOut, "index.json"),
      out: queryOut,
      filters: {
        repo: "smartsql",
        outcome: "provider_rejected",
        mutationVerdict: "unchanged"
      }
    });
    const empty = await queryPacketIndex({
      index: join(indexOut, "index.json"),
      filters: {
        scenario: "missing"
      }
    });

    expect(query.matchingCount).toBe(1);
    expect(query.records[0]).toMatchObject({
      alpha: "ALPHA-11",
      repo: "smartsql",
      outcome: "provider_rejected",
      operatorVerdict: "do_not_apply"
    });
    expect(await readFile(join(queryOut, "query.json"), "utf8")).toContain("provider_rejected");
    expect(await readFile(join(queryOut, "query.md"), "utf8")).toContain("Matching count: 1");
    expect(renderPacketQuery(empty)).toContain("No packet evidence matched");
  });

  it("builds latest dogfood reports and dashboard seed data", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-packet-report-"));
    const alpha10 = join(root, "ALPHA-10");
    const out = join(root, "out");
    await mkdir(alpha10, { recursive: true });
    await writeFile(join(alpha10, "external-dogfood-index.json"), JSON.stringify({
      entries: [
        {
          repo: "/Users/example/smartsql",
          scenario: "merge_intervals",
          outcome: "proposal_ready_verified",
          providerStatus: "accepted",
          packetPath: "/tmp/accepted/packet",
          viewerPath: "/tmp/accepted/viewer/index.html",
          externalRepoMutationVerdict: "unchanged",
          decision: "no_apply",
          notes: "verified"
        },
        {
          repo: "/Users/example/factory",
          scenario: "readme_reject",
          outcome: "provider_rejected",
          providerStatus: "rejected",
          packetPath: "/tmp/rejected/packet",
          viewerPath: "/tmp/rejected/viewer/index.html",
          externalRepoMutationVerdict: "unchanged",
          decision: "comparison_only",
          notes: "dry-run apply failed"
        }
      ]
    }), "utf8");

    const report = await buildLatestDogfoodReport({ root, out });
    const seed = await buildDashboardSeed({ root, out });

    expect(report.latestAlpha).toBe("ALPHA-10");
    expect(report.dogfoodCaseCount).toBe(2);
    expect(report.counts.byOutcome.provider_rejected).toBe(1);
    expect(report.originalReposStayedUnchanged).toBe(true);
    expect(report.latestProviderRejection?.scenario).toBe("readme_reject");
    expect(seed.schemaVersion).toBe("alpha-11-dashboard-seed");
    expect(seed.summary.total).toBe(2);
    expect(seed.records[0]).toHaveProperty("summaryPath");
    expect(await readFile(join(out, "latest-dogfood.md"), "utf8")).toContain("Latest alpha: ALPHA-10");
    expect(await readFile(join(out, "dashboard-seed.json"), "utf8")).toContain("alpha-11-dashboard-seed");
  });
});
