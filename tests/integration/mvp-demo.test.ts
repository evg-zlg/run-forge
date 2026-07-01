import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runMvpDemo } from "../../scripts/mvp-demo.js";

const execFileAsync = promisify(execFile);

describe("MVP demo runner", () => {
  it("writes a full human review packet without mutating the fixture repo", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "runforge-mvp-demo-"));
    const before = await fixtureSnapshot();

    const result = await runMvpDemo({ outputRoot: outDir });

    expect(result.fixtureUnchanged).toBe(true);
    expect(await fixtureSnapshot()).toEqual(before);
    expect(result.humanReviewPath).toBe(join(outDir, "human-review.md"));
    expect(result.proposalPatchPath).toBe(join(outDir, "proposal/proposal.patch"));
    expect(result.childRuns.map((run) => run.name)).toEqual(["context-pack", "command-check", "code-proposal"]);

    const humanReview = await readFile(result.humanReviewPath, "utf8");
    expect(humanReview).toContain("What task was attempted?");
    expect(humanReview).toContain("What context was collected?");
    expect(humanReview).toContain("What checks/evidence were used?");
    expect(humanReview).toContain("What patch is proposed?");
    expect(humanReview).toContain("Why is it safe?");
    expect(humanReview).toContain("Was the repo modified?");
    expect(humanReview).toContain("What should a human do next?");
    expect(humanReview).toContain("No LLM/API calls");

    const patch = await readFile(result.proposalPatchPath, "utf8");
    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toContain("diff --git");
    await execFileAsync("git", ["apply", "--check", result.proposalPatchPath], {
      cwd: resolve("fixtures/repos/sample-js")
    });

    await expect(readFile(join(outDir, "context/context-pack.json"), "utf8")).resolves.toContain("calculator.ts");
    await expect(readFile(join(outDir, "context/context-pack.md"), "utf8")).resolves.toContain("Context Pack");
    await expect(readFile(join(outDir, "checks/command-result.json"), "utf8")).resolves.toContain("Expected add");
    await expect(readFile(join(outDir, "checks/command-output.txt"), "utf8")).resolves.toContain("received 2");
    await expect(readFile(join(outDir, "proposal/patch-summary.md"), "utf8")).resolves.toContain("Human decision required");
    await expect(readFile(join(outDir, "child-runs.json"), "utf8")).resolves.toContain("code-proposal");

    const safetyReport = JSON.parse(await readFile(join(outDir, "safety-report.json"), "utf8")) as {
      repoMutationAllowed: boolean;
      patchMode: string;
      humanDecisionRequired: boolean;
    };
    expect(safetyReport).toMatchObject({
      repoMutationAllowed: false,
      patchMode: "proposal-only",
      humanDecisionRequired: true
    });
  });
});

async function fixtureSnapshot(): Promise<Record<string, string>> {
  const files = ["package.json", "src/calculator.ts", "tests/calculator.test.ts"];
  const snapshot: Record<string, string> = {};
  for (const file of files) {
    snapshot[file] = await readFile(join("fixtures/repos/sample-js", file), "utf8");
  }
  return snapshot;
}
