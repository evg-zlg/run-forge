import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "src/cli/index.ts");

interface CaseResult {
  name: string;
  kind: "readiness" | "code-proposal";
  status: "passed" | "failed";
  packetDir?: string;
  expected: string;
  actual?: string;
  details?: string;
}

const results: CaseResult[] = [];

async function main(): Promise<void> {
  const rawRoot = await mkdtemp("/tmp/runforge-alpha3-");
  const validationRoot = join(repoRoot, "validation", "runs", "ALPHA-3");
  await rm(validationRoot, { recursive: true, force: true });
  await mkdir(validationRoot, { recursive: true });

  await readinessCases(rawRoot);
  await codeProposalCases(rawRoot);

  await writeFile(join(validationRoot, "results.json"), `${JSON.stringify({
    schemaVersion: "alpha-3d",
    generatedAt: new Date().toISOString(),
    rawRoot,
    results
  }, null, 2)}\n`, "utf8");
  await writeFile(join(validationRoot, "summary.md"), renderSummary(rawRoot), "utf8");

  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    console.error(renderSummary(rawRoot));
    process.exitCode = 1;
    return;
  }
  console.log(renderSummary(rawRoot));
}

async function readinessCases(rawRoot: string): Promise<void> {
  const repo = await createSampleGitRepo(rawRoot, "readiness-repo");
  await recordReadiness("ready from test assertion failure", repo, assertionCommand(), "ready_for_code_proposal", rawRoot);
  await recordReadiness("ready from typecheck-style evidence", repo, "node -e \"console.error('TS2322: Type string is not assignable to type number'); process.exit(1)\"", "ready_for_code_proposal", rawRoot);
  await recordReadiness("needs_more_context from dependency_missing", repo, "node -e \"console.error('Cannot find module lodash'); process.exit(1)\"", "needs_more_context", rawRoot);
  await recordReadiness("needs_more_context from command_not_found", repo, "node -e \"console.error('command not found: definitely-not-a-real-command'); process.exit(127)\"", "needs_more_context", rawRoot);
  await recordReadiness("research_only from timeout", repo, "node -e \"setTimeout(() => {}, 2000)\"", "research_only", rawRoot, ["--timeout-ms", "100"]);
  await recordReadiness("no_failure_observed from passed packet", repo, "node -e \"console.log('ok')\"", "no_failure_observed", rawRoot);

  const safetyPacket = await createSyntheticTriagePacket(rawRoot, "blocked-safety", {
    category: "test_assertion_failure",
    safetyReport: { blockedCommands: [{ reason: "synthetic safety block" }] }
  });
  const out = join(rawRoot, "readiness-blocked-by-safety");
  await runCli(["external", "proposal-readiness", "--from-triage-packet", safetyPacket, "--out", out], rawRoot);
  await recordJsonOutcome({
    name: "blocked_by_safety synthetic case",
    kind: "readiness",
    packetDir: join(out, "packet"),
    file: "proposal-contract.json",
    field: "readinessOutcome",
    expected: "blocked_by_safety"
  });
}

async function codeProposalCases(rawRoot: string): Promise<void> {
  const verifiedRepo = await createSampleGitRepo(rawRoot, "code-verified-repo");
  const verifiedBefore = await gitStatus(verifiedRepo);
  const verifiedOut = join(rawRoot, "code-proposal-verified");
  await runCli(["external", "code-proposal", "--repo", verifiedRepo, "--command", assertionCommand(), "--out", verifiedOut], rawRoot);
  await recordJsonOutcome({
    name: "verified fixture after command passes",
    kind: "code-proposal",
    packetDir: join(verifiedOut, "packet"),
    file: "proposal-status.json",
    field: "outcome",
    expected: "proposal_ready_verified",
    details: (await gitStatus(verifiedRepo)) === verifiedBefore ? "original repo unchanged" : "original repo changed"
  });

  const readyRepo = await createSampleGitRepo(rawRoot, "code-ready-repo");
  const readyOut = join(rawRoot, "code-proposal-ready-patch");
  await runCli(["external", "code-proposal", "--repo", readyRepo, "--command", assertionCommand(), "--out", readyOut], rawRoot);
  const readyStatus = JSON.parse(await readFile(join(readyOut, "packet", "proposal-status.json"), "utf8")) as { outcome: string; patchBytes: number };
  results.push({
    name: "ready fixture proposal patch generated",
    kind: "code-proposal",
    status: readyStatus.patchBytes > 0 ? "passed" : "failed",
    packetDir: join(readyOut, "packet"),
    expected: "patchBytes > 0",
    actual: String(readyStatus.patchBytes),
    details: readyStatus.outcome
  });

  const notReadyTriage = await createSyntheticTriagePacket(rawRoot, "not-ready-triage", { category: "dependency_missing" });
  const notReadyReadiness = join(rawRoot, "not-ready-readiness");
  const notReadyOut = join(rawRoot, "code-proposal-not-ready");
  await runCli(["external", "proposal-readiness", "--from-triage-packet", notReadyTriage, "--out", notReadyReadiness], rawRoot);
  await runCli(["external", "code-proposal", "--from-readiness-packet", join(notReadyReadiness, "packet"), "--out", notReadyOut], rawRoot);
  await recordJsonOutcome({
    name: "not-ready readiness packet no patch generated",
    kind: "code-proposal",
    packetDir: join(notReadyOut, "packet"),
    file: "proposal-status.json",
    field: "outcome",
    expected: "not_ready"
  });

  const ambiguousRepo = await createPlainGitRepo(rawRoot, "ambiguous-repo");
  const ambiguousOut = join(rawRoot, "code-proposal-no-safe");
  await runCli(["external", "code-proposal", "--repo", ambiguousRepo, "--command", "node -e \"console.error('TS2322: Type string is not assignable to type number'); process.exit(1)\"", "--out", ambiguousOut], rawRoot);
  await recordJsonOutcome({
    name: "ambiguous failure no_safe_proposal",
    kind: "code-proposal",
    packetDir: join(ambiguousOut, "packet"),
    file: "proposal-status.json",
    field: "outcome",
    expected: "no_safe_proposal"
  });

  const failingRepo = await createSampleGitRepo(rawRoot, "verification-failure-repo");
  const failingOut = join(rawRoot, "code-proposal-verification-failed");
  await runCli(["external", "code-proposal", "--repo", failingRepo, "--command", "node -e \"console.error('AssertionError: expected 1 to equal 2'); process.exit(1)\"", "--out", failingOut], rawRoot);
  await recordJsonOutcome({
    name: "verification failure honest verification_failed",
    kind: "code-proposal",
    packetDir: join(failingOut, "packet"),
    file: "proposal-status.json",
    field: "outcome",
    expected: "verification_failed"
  });
}

async function recordReadiness(name: string, repo: string, command: string, expected: string, rawRoot: string, extraArgs: string[] = []): Promise<void> {
  const out = join(rawRoot, slug(name));
  await runCli(["external", "proposal-readiness", "--repo", repo, "--command", command, "--out", out, ...extraArgs], rawRoot);
  await recordJsonOutcome({
    name,
    kind: "readiness",
    packetDir: join(out, "packet"),
    file: "proposal-contract.json",
    field: "readinessOutcome",
    expected
  });
}

async function recordJsonOutcome(input: {
  name: string;
  kind: "readiness" | "code-proposal";
  packetDir: string;
  file: string;
  field: string;
  expected: string;
  details?: string;
}): Promise<void> {
  const json = JSON.parse(await readFile(join(input.packetDir, input.file), "utf8")) as Record<string, unknown>;
  const actual = String(json[input.field]);
  results.push({
    name: input.name,
    kind: input.kind,
    status: actual === input.expected ? "passed" : "failed",
    packetDir: input.packetDir,
    expected: input.expected,
    actual,
    details: input.details
  });
}

async function runCli(args: string[], cwd: string): Promise<void> {
  await execFileAsync("pnpm", ["--dir", repoRoot, "exec", "tsx", cliPath, ...args], {
    cwd,
    maxBuffer: 1024 * 1024 * 8
  });
}

function assertionCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('tests/calculator.test.ts','utf8'); if (text.includes('toBe(2)')) process.exit(0); console.error('AssertionError: expected add(1, 1) assertion to expect 2'); process.exit(1);\"";
}

async function createSampleGitRepo(rawRoot: string, name: string): Promise<string> {
  const repo = join(rawRoot, name);
  await cp(join(repoRoot, "fixtures", "repos", "sample-js"), repo, { recursive: true });
  await initGitRepo(repo);
  return repo;
}

async function createPlainGitRepo(rawRoot: string, name: string): Promise<string> {
  const repo = join(rawRoot, name);
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Plain\n", "utf8");
  await initGitRepo(repo);
  return repo;
}

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Validation", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });
}

async function gitStatus(repo: string): Promise<string> {
  const result = await execFileAsync("git", ["status", "--short"], { cwd: repo });
  return result.stdout.trim();
}

async function createSyntheticTriagePacket(rawRoot: string, name: string, input: {
  category: string;
  safetyReport?: Record<string, unknown>;
}): Promise<string> {
  const packetDir = join(rawRoot, name, "packet");
  await mkdir(packetDir, { recursive: true });
  await writeFile(join(packetDir, "root-cause.json"), `${JSON.stringify({
    schemaVersion: "alpha-3a",
    sourceCheckPacket: null,
    category: input.category,
    confidence: "high",
    requiresMoreContext: input.category !== "test_assertion_failure",
    readyForCodeProposal: input.category === "test_assertion_failure",
    safeNextAction: "Synthetic next action.",
    evidenceBasis: ["Synthetic evidence."]
  }, null, 2)}\n`, "utf8");
  await writeFile(join(packetDir, "run.json"), `${JSON.stringify({
    schemaVersion: "alpha-3a",
    status: input.category === "no_failure_observed" ? "no_failure_observed" : "triaged",
    category: input.category,
    confidence: "high"
  }, null, 2)}\n`, "utf8");
  await writeFile(join(packetDir, "safety-report.json"), `${JSON.stringify({
    schemaVersion: "alpha-3a",
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    ...input.safetyReport
  }, null, 2)}\n`, "utf8");
  return packetDir;
}

function renderSummary(rawRoot: string): string {
  const lines = [
    "# Alpha-3 Validation",
    "",
    `Raw artifacts: ${rawRoot}`,
    "",
    "| Case | Kind | Status | Expected | Actual | Packet |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => `| ${result.name} | ${result.kind} | ${result.status} | ${result.expected} | ${result.actual ?? ""} | ${result.packetDir ?? ""} |`)
  ];
  return `${lines.join("\n")}\n`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

await main();
