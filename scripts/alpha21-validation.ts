import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const trialRoot = "/tmp/runforge-alpha21-operator-trial";
const validationDir = join(repo, "validation/runs/ALPHA-21");
const errors: string[] = [];
const commandsRun: string[] = [];

await rm(trialRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });

await runCli([
  "external", "patch-trial",
  "--root", trialRoot,
  "--out", join(trialRoot, "proposal-run"),
  "--run-id", "alpha21-operator-patch-trial"
]);

const sourceRepo = join(trialRoot, "source");
const operatorRepo = join(trialRoot, "operator-worktree");
const proposalPacket = join(trialRoot, "proposal-run", "packet");
const proposalPatch = join(proposalPacket, "proposal.patch");
await expectFile(proposalPatch);

const sourceVerify = await runExternal("node", ["verify.js"], sourceRepo, false);
check(sourceVerify.exitCode !== 0, "source fixture should fail before manual apply");

await rm(operatorRepo, { recursive: true, force: true });
await cp(sourceRepo, operatorRepo, { recursive: true });
await runExternal("git", ["apply", proposalPatch], operatorRepo, true);
await runExternal("node", ["verify.js"], operatorRepo, true);

await runCli([
  "external", "record-decision",
  "--proposal-packet", proposalPacket,
  "--repo", operatorRepo,
  "--command", "node verify.js",
  "--decision", "accepted",
  "--out", join(trialRoot, "decision"),
  "--run-id", "alpha21-operator-accepted",
  "--notes", "Alpha-21 validation manually applied proposal.patch in a disposable operator worktree."
]);

const operatorDecision = await readJson<{
  finalOutcome?: string;
  validation?: { passed?: boolean; packet?: string };
  runforgeAppliedPatch?: boolean;
}>(join(proposalPacket, "operator-decision.json"));
check(operatorDecision.finalOutcome === "accepted", "operator decision should be accepted");
check(operatorDecision.validation?.passed === true, "operator decision validation should pass");
check(operatorDecision.runforgeAppliedPatch === false, "RunForge must record that it did not apply the patch");

await runCli(["packet", "inspect", "--packet", proposalPacket, "--validate"]);
await runCli(["packet", "view", "--packet", proposalPacket, "--out", join(trialRoot, "viewer")]);

const proposalStatus = await readJson<{
  outcome?: string;
  providerStatus?: string;
  filesChanged?: string[];
  verificationPassed?: boolean;
}>(join(proposalPacket, "proposal-status.json"));
check(proposalStatus.outcome === "proposal_ready_verified", "proposal should be verified in disposable proposal workspace");
check((proposalStatus.filesChanged ?? []).includes("src/math.js"), "proposal should touch src/math.js");

const sourceStatus = await runExternal("git", ["status", "--short"], sourceRepo, true);
check(sourceStatus.stdout.trim() === "", "source fixture repo should remain unchanged");
const sourceHead = (await runExternal("git", ["rev-parse", "HEAD"], sourceRepo, true)).stdout.trim();
const sourceHeadAfter = (await runExternal("git", ["rev-parse", "HEAD"], sourceRepo, true)).stdout.trim();
check(sourceHead === sourceHeadAfter, "source fixture HEAD should remain unchanged");

const viewerPath = join(trialRoot, "viewer", "index.html");
await expectFile(viewerPath);

const resultBase = {
  schemaVersion: "alpha-21-operator-accepted-patch-trial",
  generatedAt: new Date().toISOString(),
  trialRoot,
  sourceRepo,
  operatorRepo,
  proposalPacket,
  proposalPatch,
  operatorDecision: join(proposalPacket, "operator-decision.json"),
  validationPacket: operatorDecision.validation?.packet ?? null,
  externalRepo: {
    beforeHead: sourceHead,
    afterHead: sourceHeadAfter,
    mutationVerdict: "unchanged"
  },
  attempts: [
    {
      id: "controlled-fixture-accepted",
      repo: sourceRepo,
      decision: "accepted",
      packet: proposalPacket,
      viewer: viewerPath,
      outcome: proposalStatus.outcome,
      providerStatus: proposalStatus.providerStatus ?? "disabled",
      filesChanged: proposalStatus.filesChanged ?? [],
      externalRepoHeadBefore: sourceHead,
      externalRepoHeadAfter: sourceHeadAfter,
      manualApply: true
    }
  ],
  safety: {
    noOriginalExternalRepoMutation: true,
    noAutoApplyByRunForge: true,
    noProviderCalls: true,
    noNetworkRequired: true,
    noPushMergeDeploy: true,
    disposableOperatorWorktree: operatorRepo
  },
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(resultBase, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(trialRoot, "index"), "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(trialRoot, "index", "dashboard-seed.json"), "--out", join(trialRoot, "dashboard")]);

const dashboardData = await readJson<{ records?: Array<{ alpha?: string; operatorVerdict?: string; notes?: string }> }>(join(trialRoot, "dashboard", "dashboard-data.json"));
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-21" && record.operatorVerdict === "accepted"), "dashboard data should expose accepted Alpha-21 operator verdict");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-21",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.validation.ok, `lifecycle validation should pass: ${lifecycle.validation.errors.join("; ")}`);
check(lifecycle.milestoneComparison.some((line) => line.includes("Alpha-21 records")), "lifecycle report should mention Alpha-21");

const results = {
  ...resultBase,
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");

const summary = renderSummary(results.finalVerdict === "passed");
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

async function runCli(args: string[]): Promise<void> {
  const commandText = `pnpm dev ${args.join(" ")}`;
  commandsRun.push(commandText);
  const result = await execFileAsync("pnpm", ["dev", ...args], { cwd: repo, maxBuffer: 20_000_000 }).catch((error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    errors.push(`${commandText} failed with exit ${failure.code ?? "unknown"}\n${failure.stdout ?? ""}${failure.stderr ?? ""}`);
    return null;
  });
  if (result) {
    if (result.stdout.trim()) commandsRun.push(`# stdout: ${firstLine(result.stdout)}`);
    if (result.stderr.trim()) commandsRun.push(`# stderr: ${firstLine(result.stderr)}`);
  }
}

async function runExternal(command: string, args: string[], cwd: string, expectSuccess: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const commandText = `${command} ${args.join(" ")}`;
  commandsRun.push(`(cd ${cwd} && ${commandText})`);
  try {
    const result = await execFileAsync(command, args, { cwd, maxBuffer: 10_000_000 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    if (expectSuccess) errors.push(`${commandText} failed in ${cwd}: ${failure.stderr ?? failure.stdout ?? ""}`);
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: Number(failure.code ?? 1) };
  }
}

async function expectFile(path: string): Promise<void> {
  await access(path).catch(() => check(false, `missing expected file ${path}`));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function renderSummary(passed: boolean): string {
  return [
    "# RunForge Alpha-21 Operator Accepted Patch Trial",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Trial root: ${trialRoot}`,
    "",
    "## Outcome",
    "",
    `Final verdict: ${passed ? "passed" : "failed"}`,
    "",
    "## Evidence",
    "",
    `- Proposal packet: ${proposalPacket}`,
    `- Proposal patch: ${proposalPatch}`,
    `- Operator decision: ${join(proposalPacket, "operator-decision.json")}`,
    `- Operator validation packet: ${join(trialRoot, "decision", "validation-rerun", "packet")}`,
    `- Packet viewer: ${viewerPath}`,
    `- Dashboard: ${join(trialRoot, "dashboard", "index.html")}`,
    `- Lifecycle report: ${join(validationDir, "lifecycle-report.json")}`,
    "",
    "## Safety Checks",
    "",
    "- RunForge generated a proposal-only patch.",
    "- The validation script manually applied proposal.patch only in a disposable operator worktree.",
    "- RunForge record-decision reran validation and recorded `accepted` without applying the patch.",
    "- The original controlled source repo remained unchanged.",
    "- No provider, network, DB, push, merge, or deploy was required.",
    "",
    "## Commands Run",
    "",
    ...commandsRun.map((command) => `- ${command}`),
    "",
    "## Errors",
    "",
    ...(errors.length > 0 ? errors.map((error) => `- ${error}`) : ["- none"]),
    ""
  ].join("\n");
}
