import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTriage } from "../../src/triage/triage-runner.js";

describe("runTriage", () => {
  it("writes the required artifacts", async () => {
    const outPath = await mkdtemp(join(tmpdir(), "runforge-"));
    await runTriage({
      repoPath: "./fixtures/repos/sample-js",
      logPath: "./fixtures/logs/typecheck-failure.log",
      outPath,
      provider: "mock"
    });

    const review = await readFile(join(outPath, "review.md"), "utf8");
    const trajectory = JSON.parse(await readFile(join(outPath, "trajectory.json"), "utf8")) as { result: { category: string } };
    const safety = JSON.parse(await readFile(join(outPath, "safety-report.json"), "utf8")) as { secretScan: { status: string } };

    expect(review).toContain("# Failure Triage Report");
    expect(trajectory.result.category).toBe("typecheck_failure");
    expect(safety.secretScan.status).toBe("passed");
  });
});
