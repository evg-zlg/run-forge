import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeFailure } from "../src/run/external-failure-triage-classifier.js";
import type { ExternalFailureTriageSourceRun, FailureEvidence } from "../src/run/external-failure-triage-types.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-15");

interface Alpha15Results {
  schemaVersion: "alpha-15-results";
  verdict: string;
  sourceArtifacts: {
    report: string;
    results: string;
  };
  factory: {
    repo: string;
    before: { head: string; statusShort: string };
    after: { head: string; statusShort: string };
    remainedUnchanged: boolean;
    patchApplied: boolean;
  };
  runforge: {
    headUsedInTrial: string;
  };
  cases: Array<{
    id: string;
    command?: string;
    expectedAlpha15Category?: string;
    expectedAlpha15ReadinessOutcome?: string;
    codeOutcome: string;
    providerStatus: string;
    operatorVerdict: string;
    proposalPatchBytes: number;
    packetPaths: Record<string, string>;
    viewerPath: string;
  }>;
  dashboardAndIndex: Record<string, string | number>;
}

interface OperatorDecisions {
  schemaVersion: "alpha-15-operator-decisions";
  verdict: string;
  decisions: Array<{
    caseId: string;
    operatorVerdict: string;
    shouldApplyPatch: boolean;
    packet: string;
    viewer: string;
  }>;
  factorySafety: {
    beforeHead: string;
    afterHead: string;
    statusBefore: string;
    statusAfter: string;
    patchApplied: boolean;
  };
}

const errors: string[] = [];
const requiredFiles = ["summary.md", "results.json", "operator-decisions.md", "operator-decisions.json"];

for (const file of requiredFiles) {
  try {
    await readFile(join(validationDir, file), "utf8");
  } catch {
    errors.push(`missing ${file}`);
  }
}

const results = await readJson<Alpha15Results>("results.json");
const decisions = await readJson<OperatorDecisions>("operator-decisions.json");

check(results.schemaVersion === "alpha-15-results", "results schemaVersion mismatch");
check(decisions.schemaVersion === "alpha-15-operator-decisions", "operator decisions schemaVersion mismatch");
check(results.verdict === "useful_now" && decisions.verdict === "useful_now", "final verdict must be useful_now");
check(results.runforge.headUsedInTrial === "27744f01c6172ec425b91b30dacee6b987f9b41f", "RunForge trial SHA not recorded");
check(results.factory.before.head === results.factory.after.head, "Factory before/after HEAD must be unchanged");
check(results.factory.remainedUnchanged === true, "Factory unchanged flag must be true");
check(results.factory.patchApplied === false && decisions.factorySafety.patchApplied === false, "manual patch must not be applied");
check(decisions.factorySafety.statusBefore === "clean" && decisions.factorySafety.statusAfter === "clean", "Factory clean status not recorded");

const case1 = results.cases.find((item) => item.id === "case-1");
const case2 = results.cases.find((item) => item.id === "case-2");
check(Boolean(case1), "case-1 missing");
check(Boolean(case2), "case-2 missing");
if (case1) {
  check(case1.command === "pnpm typecheck", "case-1 command not recorded");
  check(case1.expectedAlpha15Category === "dependency_missing_or_environment_error", "case-1 expected setup category not recorded");
  check(case1.expectedAlpha15ReadinessOutcome === "needs_more_context", "case-1 expected readiness not recorded");
  check(case1.codeOutcome === "no_safe_proposal", "case-1 code outcome must be no_safe_proposal");
  check(case1.operatorVerdict === "do_not_apply", "case-1 operator verdict must be do_not_apply");
  check(case1.proposalPatchBytes === 0, "case-1 must not record a patch");
  check(Object.values(case1.packetPaths).every((path) => path.startsWith("/tmp/runforge-alpha15-factory-trial/")), "case-1 packet paths must be /tmp references");
  check(case1.viewerPath.endsWith("/viewer/index.html"), "case-1 viewer path missing");
}
if (case2) {
  check(case2.codeOutcome === "provider_rejected", "case-2 outcome must be provider_rejected");
  check(case2.providerStatus === "rejected", "case-2 provider status must be rejected");
  check(case2.operatorVerdict === "do_not_apply", "case-2 operator verdict must be do_not_apply");
  check(case2.proposalPatchBytes === 0, "case-2 must not record an accepted patch");
  check(Object.values(case2.packetPaths).every((path) => path.startsWith("/tmp/runforge-alpha15-factory-trial/")), "case-2 packet paths must be /tmp references");
  check(case2.viewerPath.endsWith("/viewer/index.html"), "case-2 viewer path missing");
}

check(decisions.decisions.length === 2, "operator decisions must contain two cases");
check(decisions.decisions.every((decision) => decision.shouldApplyPatch === false), "operator decisions must all refuse applying patches");
check(decisions.decisions.every((decision) => decision.operatorVerdict === "do_not_apply"), "operator decisions must be do_not_apply");
check(String(results.dashboardAndIndex.indexMarkdown).endsWith("/index/index.md"), "index markdown path not recorded");
check(String(results.dashboardAndIndex.indexJson).endsWith("/index/index.json"), "index JSON path not recorded");
check(String(results.dashboardAndIndex.dashboardHtml).endsWith("/dashboard/index.html"), "dashboard path not recorded");
check(results.dashboardAndIndex.indexedEntries === 5, "indexed entry count not recorded");

const setupAnalysis = analyzeFailure(failedRun(), [evidence([
  "Local package.json exists, but node_modules missing.",
  "error TS2688: Cannot find type definition file for 'node'.",
  "error TS2591: Cannot find name 'process'. Try `npm i --save-dev @types/node`."
].join("\n"))]);
check(setupAnalysis.category === "dependency_missing", "setup analysis should prefer dependency_missing when node_modules is missing");
check(setupAnalysis.readyForCodeProposal === false, "setup analysis must not be proposal-ready");
check(setupAnalysis.safeNextAction.includes("Install or prepare dependencies"), "setup analysis next action must mention dependency setup");

console.log(renderSummary());
if (errors.length > 0) process.exitCode = 1;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(validationDir, file), "utf8")) as T;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function renderSummary(): string {
  const lines = [
    "# RunForge Alpha-15 Validation",
    "",
    `Evidence path: ${validationDir}`,
    `Required files: ${requiredFiles.join(", ")}`,
    `Verdict: ${results.verdict}`,
    `Factory unchanged: ${results.factory.before.head === results.factory.after.head && results.factory.remainedUnchanged}`,
    `Patch applied: ${results.factory.patchApplied}`,
    `Case 1 recorded as setup/dependency follow-up: ${case1?.expectedAlpha15ReadinessOutcome === "needs_more_context"}`,
    `Case 2 recorded as provider rejection: ${case2?.codeOutcome === "provider_rejected" && case2.providerStatus === "rejected"}`,
    `Environment setup classifier gated code proposal: ${setupAnalysis.readyForCodeProposal === false}`,
    "",
    errors.length === 0 ? "Alpha-15 validation: passed" : "Alpha-15 validation: failed",
    ...errors.map((error) => `- ${error}`)
  ];
  return `${lines.join("\n")}\n`;
}

function failedRun(): ExternalFailureTriageSourceRun {
  return { status: "failed", taskType: "external_command_check" };
}

function evidence(stderrExcerpt: string): FailureEvidence {
  return {
    commandId: "command-001",
    index: 1,
    command: "pnpm typecheck",
    status: "failed",
    exitCode: 2,
    timedOut: false,
    stdoutPath: "logs/command-001.stdout.log",
    stderrPath: "logs/command-001.stderr.log",
    stdoutExcerpt: "",
    stderrExcerpt,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}
