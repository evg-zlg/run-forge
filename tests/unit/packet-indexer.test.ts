import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPacketIndex, renderPacketIndexMarkdown } from "../../src/run/packet-indexer.js";

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
});
