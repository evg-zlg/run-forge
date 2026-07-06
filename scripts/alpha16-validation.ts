import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeFailure } from "../src/run/external-failure-triage-classifier.js";
import type { ExternalFailureTriageSourceRun, FailureEvidence } from "../src/run/external-failure-triage-types.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-16");
const errors: string[] = [];
const requiredFiles = ["summary.md", "results.json"];

interface Alpha16Results {
  schemaVersion: "alpha-16-results";
  verdict: "passed";
  implementation: {
    baseSha: string;
    setupCliSupported: boolean;
    repeatedSetupCommandsSupported: boolean;
    setupRunsOnlyInDisposableWorkspace: boolean;
    automaticInstallEnabled: boolean;
    combinedCodeProposalPassThrough: boolean;
  };
  artifacts: {
    setupResults: string;
    setupStdoutLog: string;
    setupStderrLog: string;
    summaryIncludesSetupPhase: boolean;
    safetyReportIncludesSetupFields: boolean;
  };
  scenarios: Array<{
    id: string;
    status: string;
    mainCommandsRun: number;
    setupCommandsRun: number;
    originalRepoUnchanged: boolean;
    readinessOutcome?: string;
    codeProposalOutcome?: string;
  }>;
}

for (const file of requiredFiles) {
  try {
    await readFile(join(validationDir, file), "utf8");
  } catch {
    errors.push(`missing ${file}`);
  }
}

const results = await readJson<Alpha16Results>("results.json");
check(results.schemaVersion === "alpha-16-results", "results schemaVersion mismatch");
check(results.verdict === "passed", "verdict must be passed");
check(results.implementation.setupCliSupported, "setup CLI support not recorded");
check(results.implementation.repeatedSetupCommandsSupported, "repeated setup command support not recorded");
check(results.implementation.setupRunsOnlyInDisposableWorkspace, "disposable workspace setup boundary not recorded");
check(results.implementation.automaticInstallEnabled === false, "automatic install must remain disabled");
check(results.implementation.combinedCodeProposalPassThrough, "combined code-proposal setup pass-through not recorded");
check(results.artifacts.setupResults === "setup-results.json", "setup-results artifact not recorded");
check(results.artifacts.setupStdoutLog === "logs/setup-001.stdout.log", "setup stdout log path not recorded");
check(results.artifacts.setupStderrLog === "logs/setup-001.stderr.log", "setup stderr log path not recorded");
check(results.artifacts.summaryIncludesSetupPhase, "summary setup phase not recorded");
check(results.artifacts.safetyReportIncludesSetupFields, "safety setup fields not recorded");

const scenarioIds = new Set(results.scenarios.map((scenario) => scenario.id));
for (const id of [
  "setup-pass-main-pass",
  "setup-pass-main-fail",
  "setup-fail-main-skipped",
  "setup-timeout",
  "setup-logs-persisted",
  "original-repo-unchanged",
  "triage-setup-failure",
  "readiness-setup-failure",
  "code-proposal-refuses-setup-failure",
  "packet-validation"
]) {
  check(scenarioIds.has(id), `missing scenario ${id}`);
}

const setupFail = results.scenarios.find((scenario) => scenario.id === "setup-fail-main-skipped");
check(setupFail?.status === "setup_failed", "setup failure status not recorded");
check(setupFail?.mainCommandsRun === 0, "main commands must be skipped after setup failure");

const timeout = results.scenarios.find((scenario) => scenario.id === "setup-timeout");
check(timeout?.status === "setup_timed_out", "setup timeout status not recorded");

const readiness = results.scenarios.find((scenario) => scenario.id === "readiness-setup-failure");
check(readiness?.readinessOutcome === "needs_more_context", "setup failure readiness must be needs_more_context");

const proposal = results.scenarios.find((scenario) => scenario.id === "code-proposal-refuses-setup-failure");
check(proposal?.codeProposalOutcome === "not_ready", "code proposal must refuse setup failure");

const setupAnalysis = analyzeFailure(setupFailedRun(), [setupEvidence("Local package.json exists, but node_modules missing.")]);
check(setupAnalysis.category === "dependency_missing", "setup failure should classify as dependency_missing when dependency evidence exists");
check(setupAnalysis.readyForCodeProposal === false, "setup failure must not be proposal-ready");
check(setupAnalysis.requiresMoreContext === true, "setup failure must require more context");
check(setupAnalysis.safeNextAction.includes("setup/preflight logs"), "setup failure next action must mention setup/preflight logs");

console.log(renderSummary());
if (errors.length > 0) process.exitCode = 1;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(validationDir, file), "utf8")) as T;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function renderSummary(): string {
  return [
    "# RunForge Alpha-16 Validation",
    "",
    `Evidence path: ${validationDir}`,
    `Required files: ${requiredFiles.join(", ")}`,
    `Verdict: ${results.verdict}`,
    `Scenarios recorded: ${results.scenarios.length}`,
    `Setup failure gated code proposal: ${setupAnalysis.readyForCodeProposal === false}`,
    "",
    errors.length === 0 ? "Alpha-16 validation: passed" : "Alpha-16 validation: failed",
    ...errors.map((error) => `- ${error}`)
  ].join("\n");
}

function setupFailedRun(): ExternalFailureTriageSourceRun {
  return { status: "setup_failed", taskType: "external_command_check" };
}

function setupEvidence(stderrExcerpt: string): FailureEvidence {
  return {
    commandId: "run:setup:001",
    phase: "setup",
    index: 1,
    command: "pnpm install --frozen-lockfile",
    status: "failed",
    exitCode: 1,
    timedOut: false,
    stdoutPath: "logs/setup-001.stdout.log",
    stderrPath: "logs/setup-001.stderr.log",
    stdoutExcerpt: "",
    stderrExcerpt,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}
