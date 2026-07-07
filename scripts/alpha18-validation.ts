import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runExternalCommandCheck } from "../src/run/external-command-check.js";
import { runExternalProposalReadiness } from "../src/run/external-proposal-readiness.js";
import { exportOkfBundle, validateOkfBundle } from "../src/run/okf-knowledge-export.js";

const exec = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = join(repo, "validation/runs");
const temp = await mkdtemp(join(tmpdir(), "runforge-alpha18-"));
const errors: string[] = [];

const fixture = await createFixtureRepo();

const intentCheck = await runExternalCommandCheck({
  repo: fixture,
  setupCommands: ["node -e \"console.log('setup ok')\""],
  setupNetworkIntent: "expected",
  commands: ["node -e \"console.log('main ok')\""],
  out: join(temp, "intent")
});
const intentRun = await readPacketJson<{ setupPolicy?: { networkIntent?: string } }>(intentCheck.packetDir, "run.json");
const intentMetrics = await readPacketJson<{ setupNetworkIntent?: string }>(intentCheck.packetDir, "metrics.json");
const intentSafety = await readPacketJson<{ setupNetworkIntentEnforced?: boolean; setupPolicyNotes?: string[] }>(intentCheck.packetDir, "safety-report.json");
const intentSummary = await readFile(join(intentCheck.packetDir, "summary.md"), "utf8");
check(intentCheck.status === "passed", "network-intent check should pass");
check(intentRun.setupPolicy?.networkIntent === "expected", "run.json must record setup network intent");
check(intentMetrics.setupNetworkIntent === "expected", "metrics.json must record setup network intent");
check(intentSafety.setupNetworkIntentEnforced === false, "safety report must state setup network intent is not enforced");
check((intentSafety.setupPolicyNotes ?? []).join("\n").includes("does not enforce network blocking"), "safety report must describe audit-only network intent");
check(intentSummary.includes("Network intent: expected"), "summary must render setup network intent");

const defaultGate = await runExternalCommandCheck({
  repo: fixture,
  setupCommands: ["node -e \"console.error('setup failed'); process.exit(1)\""],
  commands: ["node -e \"console.log('main should not run')\""],
  out: join(temp, "default-gate")
});
const defaultMetrics = await readPacketJson<{ commandsRun?: number }>(defaultGate.packetDir, "metrics.json");
check(defaultGate.status === "setup_failed", "default setup failure should keep setup_failed status");
check(defaultMetrics.commandsRun === 0, "main commands must be skipped by default after setup failure");

const diagnostic = await runExternalCommandCheck({
  repo: fixture,
  setupCommands: ["node -e \"console.error('setup failed'); process.exit(1)\""],
  continueAfterSetupFailure: true,
  commands: ["node -e \"console.log('diagnostic main passed')\""],
  out: join(temp, "diagnostic")
});
const diagnosticRun = await readPacketJson<{ setupPolicy?: { continueAfterSetupFailure?: boolean }; commands?: Array<{ status?: string }> }>(diagnostic.packetDir, "run.json");
const diagnosticEvents = await readFile(join(diagnostic.packetDir, "events.jsonl"), "utf8");
const diagnosticSummary = await readFile(join(diagnostic.packetDir, "summary.md"), "utf8");
check(diagnostic.status === "setup_failed_main_passed", "diagnostic setup failure with passing main command should have degraded status");
check(diagnosticRun.setupPolicy?.continueAfterSetupFailure === true, "diagnostic policy must be recorded in run.json");
check(diagnosticRun.commands?.[0]?.status === "passed", "diagnostic main command should run and pass");
check(diagnosticEvents.includes("setup_diagnostic_main_commands_started"), "diagnostic event must be recorded");
check(diagnosticSummary.includes("do not treat this as a clean verification environment"), "diagnostic caution must be rendered");

const readiness = await runExternalProposalReadiness({
  repo: fixture,
  setupCommands: ["node -e \"console.error('setup failed'); process.exit(1)\""],
  continueAfterSetupFailure: true,
  commands: ["node -e \"console.log('diagnostic main passed')\""],
  out: join(temp, "readiness")
});
check(readiness.readinessOutcome === "needs_more_context", "diagnostic setup failure must keep readiness conservative");
check(readiness.canAttemptCodeProposal === false, "diagnostic setup failure must block code proposal attempts");
check(readiness.recommendedNextAction.includes("Fix setup/preflight first"), "diagnostic readiness next action must mention setup first");

const okf = await exportOkfBundle({ root: runs, out: join(temp, "okf") });
const okfValidation = await validateOkfBundle(okf.out);
check(okfValidation.ok, `OKF validation failed: ${okfValidation.errors.join("; ")}`);
check(okf.files.includes("concepts/setup-network-intent.md"), "OKF setup network intent concept missing");
check(okf.files.includes("concepts/diagnostic-setup-mode.md"), "OKF diagnostic setup mode concept missing");
check(okf.files.includes("decisions/alpha-18-setup-policy.md"), "OKF Alpha-18 setup policy decision missing");

console.log(renderSummary());
if (errors.length > 0) process.exitCode = 1;

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runforge-alpha18-fixture-"));
  await writeFile(join(dir, "package.json"), "{\"scripts\":{\"check\":\"node -e \\\"console.log('ok')\\\"\"}}\n", "utf8");
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "runforge@example.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "RunForge Validation"], { cwd: dir });
  await exec("git", ["add", "package.json"], { cwd: dir });
  await exec("git", ["commit", "-m", "fixture"], { cwd: dir });
  return dir;
}

async function readPacketJson<T>(packetDir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(packetDir, file), "utf8")) as T;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function renderSummary(): string {
  return [
    "# RunForge Alpha-18 Validation",
    "",
    `Temporary output: ${temp}`,
    `Intent packet: ${intentCheck.packetDir}`,
    `Diagnostic packet: ${diagnostic.packetDir}`,
    `Readiness packet: ${readiness.packetDir}`,
    `OKF files: ${okf.files.length}`,
    "",
    errors.length === 0 ? "Alpha-18 validation: passed" : "Alpha-18 validation: failed",
    ...errors.map((error) => `- ${error}`)
  ].join("\n");
}
