import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runTriage } from "../src/triage/triage-runner.js";

type Scores = {
  rootCause: number;
  evidence: number;
  safeNextCommand: number;
  honestyCheckedNotChecked: number;
  security: "pass" | "fail";
};

type Metadata = {
  caseId: string;
  title: string;
  categoryExpected: string;
  repoPath: string;
  source: "fixture" | "placeholder";
  placeholderReason?: string;
  initialScore: Scores;
  usefulReport: boolean;
};

const casesDir = "validation/cases";
const runsDir = "validation/runs";

const caseIds = (await readdir(casesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^case-\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const summaries = [];

for (const caseId of caseIds) {
  const caseDir = join(casesDir, caseId);
  const runDir = join(runsDir, caseId);
  const metadata = JSON.parse(await readFile(join(caseDir, "metadata.json"), "utf8")) as Metadata;

  await mkdir(runDir, { recursive: true });
  await runTriage({
    repoPath: metadata.repoPath,
    logPath: join(caseDir, "input.log"),
    outPath: runDir,
    provider: "mock"
  });

  const trajectory = JSON.parse(await readFile(join(runDir, "trajectory.json"), "utf8")) as {
    result: { category: string };
    security: { secretScan: string };
  };
  const scorePath = join(runDir, "score.json");
  const score = existsSync(scorePath)
    ? JSON.parse(await readFile(scorePath, "utf8"))
    : makeScore(metadata, trajectory.result.category, trajectory.security.secretScan);

  await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf8");
  summaries.push(score);
}

await writeFile("validation/validation-summary.md", renderSummary(summaries), "utf8");
console.log(`Validation completed for ${summaries.length} cases.`);

function makeScore(metadata: Metadata, categoryActual: string, secretScan: string) {
  return {
    caseId: metadata.caseId,
    title: metadata.title,
    categoryExpected: metadata.categoryExpected,
    categoryActual,
    source: metadata.source,
    placeholderReason: metadata.placeholderReason,
    scores: {
      ...metadata.initialScore,
      security: secretScan === "passed" ? metadata.initialScore.security : "fail"
    },
    usefulReport: metadata.usefulReport,
    notes:
      metadata.source === "placeholder"
        ? "Placeholder case until more sanitized real failure logs are available."
        : "Initial score seeded from case metadata; replace with human review after reading review.md."
  };
}

function renderSummary(scores: Array<ReturnType<typeof makeScore>>): string {
  const securityPass = scores.filter((score) => score.scores.security === "pass").length;
  const usefulReports = scores.filter((score) => score.usefulReport).length;
  const categoryCounts = countBy(scores.map((score) => score.categoryActual));
  const placeholders = scores.filter((score) => score.source === "placeholder");

  return `# Validation Summary

- Total cases: ${scores.length}
- Case categories: ${Object.entries(categoryCounts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ") || "none"}
- Root cause score average: ${avg(scores.map((score) => score.scores.rootCause))}
- Evidence score average: ${avg(scores.map((score) => score.scores.evidence))}
- Safe command score average: ${avg(scores.map((score) => score.scores.safeNextCommand))}
- Honesty score average: ${avg(scores.map((score) => score.scores.honestyCheckedNotChecked))}
- Security pass/fail count: ${securityPass} pass / ${scores.length - securityPass} fail
- Useful report rate: ${
    scores.length ? `${usefulReports}/${scores.length} (${Math.round((usefulReports / scores.length) * 100)}%)` : "0/0"
  }

## Missing Real-log Gaps

${placeholders.length ? placeholders.map((score) => `- ${score.caseId}: ${score.placeholderReason}`).join("\n") : "- None."}

## Cases

${scores.map((score) => `- ${score.caseId}: ${score.title} (${score.categoryActual}, ${score.source})`).join("\n")}
`;
}

function avg(values: number[]): string {
  if (!values.length) return "0.00";
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
