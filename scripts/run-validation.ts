import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FailureCategory } from "../src/core/types.js";
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
  source: "real" | "fixture" | "placeholder";
  placeholderReason?: string;
  initialScore: Scores;
  usefulReport: boolean;
};

type RealCase = {
  id: string;
  dataset: string;
  class: string;
  sourceKind: string;
  sourcePath: string;
  sourceReference: string;
  sanitization: {
    secretsRemoved: boolean;
    rawTokensRemoved: boolean;
    customerDataRemoved: boolean;
    notes: string;
  };
  command: string;
  observedFailure: {
    summary: string;
    excerpt: string[];
    exitCode: number | null;
  };
  expectedRunForgeClassification: {
    primary: string;
    secondary: string[];
    retryable: boolean;
    likelyOwner: string;
  };
};

const casesDir = "validation/cases";
const runsDir = "validation/runs";
const realDatasetDir = "tests/fixtures/runforge/failure-cases/real-log-dataset-01";

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

if (existsSync(realDatasetDir)) {
  const realCaseFiles = (await readdir(realDatasetDir))
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const fileName of realCaseFiles) {
    const realCase = JSON.parse(await readFile(join(realDatasetDir, fileName), "utf8")) as RealCase;
    const runDir = join(runsDir, realCase.id);
    const logPath = join(runDir, "input.log");

    await mkdir(runDir, { recursive: true });
    await writeFile(logPath, renderRealCaseInput(realCase), "utf8");
    await runTriage({
      repoPath: "./fixtures/repos/sample-js",
      logPath,
      outPath: runDir,
      provider: "mock"
    });

    const trajectory = JSON.parse(await readFile(join(runDir, "trajectory.json"), "utf8")) as {
      result: { category: FailureCategory };
      security: { secretScan: string };
    };
    const score = makeRealScore(realCase, trajectory.result.category, trajectory.security.secretScan);
    await writeFile(join(runDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf8");
    summaries.push(score);
  }
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

function makeRealScore(realCase: RealCase, categoryActual: FailureCategory, secretScan: string) {
  const expectedCategories = mapExpectedCategories(realCase.expectedRunForgeClassification.primary);
  const classificationMatched = expectedCategories.includes(categoryActual);
  const unsupportedOtherClass = realCase.expectedRunForgeClassification.primary === "real_failure_other";
  const security = secretScan === "passed" ? "pass" : "fail";
  const usefulReport = security === "pass" && classificationMatched && !unsupportedOtherClass;

  return {
    caseId: realCase.id,
    title: realCase.observedFailure.summary,
    categoryExpected: realCase.expectedRunForgeClassification.primary,
    categoryActual,
    source: "real" as const,
    dataset: realCase.dataset,
    originalCaseId: realCase.id,
    sourceKind: realCase.sourceKind,
    sourcePath: realCase.sourcePath,
    sourceReference: realCase.sourceReference,
    sanitized: true,
    expectedSecondary: realCase.expectedRunForgeClassification.secondary,
    retryable: realCase.expectedRunForgeClassification.retryable,
    likelyOwner: realCase.expectedRunForgeClassification.likelyOwner,
    classificationMatched,
    scores: {
      rootCause: classificationMatched && !unsupportedOtherClass ? 3 : unsupportedOtherClass ? 1 : 0,
      evidence: realCase.observedFailure.excerpt.length ? 3 : 1,
      safeNextCommand: classificationMatched && !unsupportedOtherClass ? 2 : 1,
      honestyCheckedNotChecked: 3,
      security
    },
    usefulReport,
    notes:
      "Current score is deterministic/heuristic and should be reviewed manually before claiming product validation."
  };
}

function renderRealCaseInput(realCase: RealCase): string {
  return [
    `Case: ${realCase.id}`,
    `Dataset: ${realCase.dataset}`,
    `Class: ${realCase.class}`,
    `Source kind: ${realCase.sourceKind}`,
    `Source path: ${realCase.sourcePath}`,
    `Source reference: ${realCase.sourceReference}`,
    `Command: ${realCase.command}`,
    `Exit code: ${realCase.observedFailure.exitCode ?? "unknown"}`,
    "",
    "Sanitization:",
    `- Secrets removed: ${realCase.sanitization.secretsRemoved}`,
    `- Raw tokens removed: ${realCase.sanitization.rawTokensRemoved}`,
    `- Customer data removed: ${realCase.sanitization.customerDataRemoved}`,
    `- Notes: ${realCase.sanitization.notes}`,
    "",
    "Observed failure:",
    realCase.observedFailure.summary,
    "",
    "Observed excerpt:",
    ...realCase.observedFailure.excerpt.map((line) => `- ${line}`),
    "",
    "Expected classification:",
    `- Primary: ${realCase.expectedRunForgeClassification.primary}`,
    `- Secondary: ${realCase.expectedRunForgeClassification.secondary.join(", ")}`,
    `- Retryable: ${realCase.expectedRunForgeClassification.retryable}`,
    `- Likely owner: ${realCase.expectedRunForgeClassification.likelyOwner}`,
    ""
  ].join("\n");
}

function mapExpectedCategories(expected: string): FailureCategory[] {
  if (expected === "typecheck_build_failure") return ["typecheck_failure", "build_failure"];
  if (expected === "env_config_dependency_failure") return ["env_config_failure", "dependency_failure"];
  if (expected === "real_failure_other") return [];
  if (isFailureCategory(expected)) return [expected];
  return [];
}

function isFailureCategory(value: string): value is FailureCategory {
  return [
    "test_failure",
    "typecheck_failure",
    "build_failure",
    "env_config_failure",
    "dependency_failure",
    "infra_timeout_failure",
    "unknown_failure"
  ].includes(value);
}

function renderSummary(scores: Array<ReturnType<typeof makeScore>>): string {
  const categoryCounts = countBy(scores.map((score) => score.categoryActual));
  const placeholders = scores.filter((score) => score.source === "placeholder");
  const real = scores.filter((score) => score.source === "real");
  const fixtures = scores.filter((score) => score.source === "fixture");
  const nonPlaceholders = scores.filter((score) => score.source !== "placeholder");
  const weakRealCases = real.filter((score) => !score.usefulReport);

  return `# Validation Summary

- Total cases: ${scores.length}
- Source mix: real: ${real.length}, fixture: ${fixtures.length}, placeholder: ${placeholders.length}
- Real useful report rate: ${renderUsefulRate(real)}
- Case categories: ${Object.entries(categoryCounts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ") || "none"}
- Validated coverage, excluding placeholders: ${nonPlaceholders.length}/${scores.length}

## Metrics By Source

${renderSourceMetrics("Real logs", real)}

${renderSourceMetrics("Fixture logs", fixtures)}

${renderSourceMetrics("Placeholder cases", placeholders)}

## Missing Real-log Gaps

${placeholders.length ? placeholders.map((score) => `- ${score.caseId}: ${score.placeholderReason}`).join("\n") : "- None."}

## Weak Real Cases

${weakRealCases.length ? weakRealCases.map((score) => `- ${score.caseId}: expected ${score.categoryExpected}, got ${score.categoryActual}; ${score.notes}`).join("\n") : "- None."}

## Scoring Note

Current score is deterministic/heuristic and should be reviewed manually before claiming product validation. This summary does not claim market or product validation.

## Cases

${scores.map((score) => `- ${score.caseId}: ${score.title} (${score.categoryActual}, ${score.source})`).join("\n")}
`;
}

function renderSourceMetrics(label: string, group: Array<ReturnType<typeof makeScore>>): string {
  const securityPass = group.filter((score) => score.scores.security === "pass").length;
  const usefulReports = group.filter((score) => score.usefulReport).length;

  return `### ${label}

- Cases: ${group.length}
- Root cause score average: ${avg(group.map((score) => score.scores.rootCause))}
- Evidence score average: ${avg(group.map((score) => score.scores.evidence))}
- Safe command score average: ${avg(group.map((score) => score.scores.safeNextCommand))}
- Honesty score average: ${avg(group.map((score) => score.scores.honestyCheckedNotChecked))}
- Security pass/fail count: ${securityPass} pass / ${group.length - securityPass} fail
- Useful report rate: ${renderUsefulRate(group)}`;
}

function renderUsefulRate(group: Array<ReturnType<typeof makeScore>>): string {
  const usefulReports = group.filter((score) => score.usefulReport).length;
  return group.length ? `${usefulReports}/${group.length} (${Math.round((usefulReports / group.length) * 100)}%)` : "0/0";
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
