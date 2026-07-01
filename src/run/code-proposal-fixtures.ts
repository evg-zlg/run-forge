import { readText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { join } from "node:path";

export interface DeterministicCodeProposal {
  taskSummary: string;
  filesChanged: string[];
  rationale: string;
  patch: string;
}

export async function buildFixtureCodeProposal(spec: RunSpec): Promise<DeterministicCodeProposal | null> {
  const testPath = "tests/calculator.test.ts";
  const testText = await readOptionalRepoFile(spec.repoPath, testPath);
  if (!testText) return null;
  if (!testText.includes("expect(add(1, 1)).toBe(3);")) return null;

  return {
    taskSummary: spec.goal ?? "Fix the sample-js calculator assertion.",
    filesChanged: [testPath],
    rationale: "The fixture's add function returns the arithmetic sum, so the assertion should expect 2 for add(1, 1).",
    patch: renderCalculatorAssertionPatch()
  };
}

async function readOptionalRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    return await readText(join(repoPath, relativePath));
  } catch {
    return null;
  }
}

function renderCalculatorAssertionPatch(): string {
  return [
    "diff --git a/tests/calculator.test.ts b/tests/calculator.test.ts",
    "--- a/tests/calculator.test.ts",
    "+++ b/tests/calculator.test.ts",
    '@@ -3,6 +3,6 @@ import { add } from "../src/calculator";',
    " ",
    ' describe("add", () => {',
    '   it("adds two numbers", () => {',
    "-    expect(add(1, 1)).toBe(3);",
    "+    expect(add(1, 1)).toBe(2);",
    "   });",
    " });"
  ].join("\n") + "\n";
}
