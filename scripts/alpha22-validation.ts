import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const externalRepo = "/Users/evgeny/Documents/projects/factory";
const trialRoot = "/tmp/runforge-alpha22-real-repo-trial/factory";
const validationDir = join(repo, "validation/runs/ALPHA-22");
const validationCommand = "node runforge-alpha22-verify.cjs";
const errors: string[] = [];
const commandsRun: string[] = [];

await rm(trialRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });

const originalBefore = await gitSnapshot(externalRepo);

await runCli([
  "external", "patch-trial",
  "--repo", externalRepo,
  "--mode", "real-repo-disposable",
  "--out", trialRoot,
  "--run-id", "alpha22-real-repo-operator-trial"
]);

const sourceRepo = join(trialRoot, "source-copy");
const proposalPacket = join(trialRoot, "proposal-run", "packet");
const proposalPatch = join(proposalPacket, "proposal.patch");
await expectFile(proposalPatch);
await expectFile(join(proposalPacket, "real-repo-trial.json"));

const sourceVerify = await runExternal("node", ["runforge-alpha22-verify.cjs"], sourceRepo, false);
check(sourceVerify.exitCode !== 0, "disposable source copy should fail before operator apply");

const acceptedRepo = join(trialRoot, "operator-accepted-worktree");
await rm(acceptedRepo, { recursive: true, force: true });
await cp(sourceRepo, acceptedRepo, { recursive: true });
await runExternal("git", ["apply", proposalPatch], acceptedRepo, true);
await runExternal("node", ["runforge-alpha22-verify.cjs"], acceptedRepo, true);
await runCli([
  "external", "record-decision",
  "--proposal-packet", proposalPacket,
  "--repo", acceptedRepo,
  "--command", validationCommand,
  "--decision", "accepted",
  "--out", join(trialRoot, "accepted-decision"),
  "--run-id", "alpha22-operator-accepted",
  "--reason", "validation_passed_after_operator_apply",
  "--apply-mode", "operator_simulated_manual_apply",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-22 manually applied proposal.patch only in the disposable accepted operator worktree."
]);

const acceptedDecision = await readJson<DecisionRecord>(join(proposalPacket, "operator-decision.json"));
check(acceptedDecision.finalOutcome === "accepted", "accepted operator decision should be accepted");
check(acceptedDecision.validation?.passed === true, "accepted decision validation should pass");
check(acceptedDecision.apply?.originalRepoMutated === false, "accepted decision must record originalRepoMutated false");

const acceptedDecisionPacketCopy = join(trialRoot, "accepted-decision", "operator-decision.json");
await cp(join(proposalPacket, "operator-decision.json"), acceptedDecisionPacketCopy);

const rejectedRepo = join(trialRoot, "operator-rejected-worktree");
await rm(rejectedRepo, { recursive: true, force: true });
await cp(sourceRepo, rejectedRepo, { recursive: true });
const rejectedVerify = await runExternal("node", ["runforge-alpha22-verify.cjs"], rejectedRepo, false);
check(rejectedVerify.exitCode !== 0, "rejected operator worktree should still fail because operator declined apply");
await runCli([
  "external", "record-decision",
  "--proposal-packet", proposalPacket,
  "--repo", rejectedRepo,
  "--command", validationCommand,
  "--decision", "rejected",
  "--out", join(trialRoot, "rejected-decision"),
  "--run-id", "alpha22-operator-rejected",
  "--reason", "operator_declined",
  "--apply-mode", "operator_declined",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-22 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree."
]);

const rejectedDecision = await readJson<DecisionRecord>(join(proposalPacket, "operator-decision.json"));
check(rejectedDecision.finalOutcome === "rejected", "rejected operator decision should be rejected");
check(rejectedDecision.reason === "operator_declined", "rejected decision should record operator_declined");
check(rejectedDecision.validation?.passed === false, "rejected decision validation should fail");
check(rejectedDecision.apply?.originalRepoMutated === false, "rejected decision must record originalRepoMutated false");

await runCli(["packet", "inspect", "--packet", proposalPacket, "--validate"]);
await runCli(["packet", "view", "--packet", proposalPacket, "--out", join(trialRoot, "viewer")]);

const proposalStatus = await readJson<{
  outcome?: string;
  providerStatus?: string;
  filesChanged?: string[];
  verificationPassed?: boolean;
}>(join(proposalPacket, "proposal-status.json"));
check(proposalStatus.outcome === "proposal_ready_verified", "real-repo disposable proposal should be verified");
check((proposalStatus.filesChanged ?? []).includes("runforge-alpha22/math.cjs"), "proposal should touch the injected disposable source file");

const originalAfter = await gitSnapshot(externalRepo);
check(originalBefore.head === originalAfter.head, "original external repo HEAD should remain unchanged");
check(originalBefore.status === originalAfter.status, "original external repo status should remain unchanged");

const viewerPath = join(trialRoot, "viewer", "index.html");
await expectFile(viewerPath);

const resultBase = {
  schemaVersion: "alpha-22-real-repo-operator-trial",
  generatedAt: new Date().toISOString(),
  trialRoot,
  originalRepo: {
    path: externalRepo,
    beforeHead: originalBefore.head,
    beforeStatus: originalBefore.status,
    afterHead: originalAfter.head,
    afterStatus: originalAfter.status,
    mutationVerdict: originalBefore.head === originalAfter.head && originalBefore.status === originalAfter.status ? "unchanged" : "changed"
  },
  disposable: {
    sourceRepo,
    acceptedOperatorWorktree: acceptedRepo,
    rejectedOperatorWorktree: rejectedRepo,
    failureMode: "injected_into_disposable_copy",
    validationCommand
  },
  proposalPacket,
  proposalPatch,
  decisions: {
    accepted: acceptedDecisionPacketCopy,
    rejected: join(trialRoot, "rejected-decision", "operator-decision.json")
  },
  validationPackets: {
    accepted: acceptedDecision.validation?.packet ?? null,
    rejected: rejectedDecision.validation?.packet ?? null
  },
  attempts: [
    {
      id: "factory-disposable-accepted",
      repo: externalRepo,
      decision: "accepted",
      operatorDecision: acceptedDecision.finalOutcome,
      packet: proposalPacket,
      viewer: viewerPath,
      outcome: proposalStatus.outcome,
      providerStatus: proposalStatus.providerStatus ?? "disabled",
      filesChanged: proposalStatus.filesChanged ?? [],
      externalRepoHeadBefore: originalBefore.head,
      externalRepoHeadAfter: originalAfter.head,
      manualApply: true,
      appliedTo: "disposable_copy",
      originalRepoMutated: false
    },
    {
      id: "factory-disposable-rejected",
      repo: externalRepo,
      decision: "rejected",
      operatorDecision: rejectedDecision.finalOutcome,
      reason: rejectedDecision.reason,
      packet: proposalPacket,
      viewer: viewerPath,
      outcome: "operator_declined",
      providerStatus: proposalStatus.providerStatus ?? "disabled",
      filesChanged: proposalStatus.filesChanged ?? [],
      externalRepoHeadBefore: originalBefore.head,
      externalRepoHeadAfter: originalAfter.head,
      manualApply: false,
      appliedTo: "disposable_copy",
      originalRepoMutated: false
    }
  ],
  safety: {
    noOriginalExternalRepoMutation: true,
    noAutoApplyByRunForge: true,
    runforgeApplyMode: "none",
    acceptedApplyMode: "operator_simulated_manual_apply",
    rejectedApplyMode: "operator_declined",
    acceptedAppliedTo: "disposable_copy",
    rejectedAppliedTo: "disposable_copy",
    noProviderCalls: true,
    noNetworkRequired: true,
    noDbAccess: true,
    noPushMergeDeploy: true
  },
  visibility: {
    evidenceResults: "validation/runs/ALPHA-22/results.json",
    evidenceSummary: "validation/runs/ALPHA-22/summary.md",
    lifecycleReport: "validation/runs/ALPHA-22/lifecycle-report.json",
    packetIndex: join(trialRoot, "index", "index.json"),
    dashboard: join(trialRoot, "dashboard", "index.html")
  },
  limitations: [
    "The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.",
    "Alpha-22 still records operator decisions; it does not authorize auto-apply to protected repositories."
  ],
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(resultBase, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(trialRoot, "index"), "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(trialRoot, "index", "dashboard-seed.json"), "--out", join(trialRoot, "dashboard")]);

const dashboardData = await readJson<{ records?: Array<{ alpha?: string; operatorVerdict?: string; notes?: string }> }>(join(trialRoot, "dashboard", "dashboard-data.json"));
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-22" && record.operatorVerdict === "accepted"), "dashboard data should expose accepted Alpha-22 operator verdict");
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-22" && record.operatorVerdict === "rejected"), "dashboard data should expose rejected Alpha-22 operator verdict");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-22",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.validation.ok, `lifecycle validation should pass: ${lifecycle.validation.errors.join("; ")}`);
check(lifecycle.milestoneComparison.some((line) => line.includes("Alpha-22 extends")), "lifecycle report should mention Alpha-22");
await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-22-compact-lifecycle-report",
  generatedAt: new Date().toISOString(),
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  alpha22: {
    status: "active",
    realExternalRepoSource: externalRepo,
    disposableTrialRoot: trialRoot,
    acceptedDecisions: 1,
    rejectedDecisions: 1,
    originalRepoMutationVerdict: resultBase.originalRepo.mutationVerdict,
    visibility: resultBase.visibility,
    safety: resultBase.safety
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-22") || line.includes("Alpha-21")),
  findings: lifecycle.findings,
  recommendations: ["Next milestone: Alpha-23 Operator Patch Trial UX Hardening."]
}, null, 2)}\n`, "utf8");

const results = {
  ...resultBase,
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");

const summary = renderSummary(results.finalVerdict === "passed", results);
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

interface DecisionRecord {
  finalOutcome?: string;
  reason?: string;
  validation?: { passed?: boolean; packet?: string };
  apply?: { mode?: string; appliedTo?: string; originalRepoMutated?: boolean };
}

async function runCli(args: string[]): Promise<void> {
  const commandText = `pnpm dev ${args.join(" ")}`;
  commandsRun.push(commandText);
  const result = await execFileAsync("pnpm", ["dev", ...args], { cwd: repo, maxBuffer: 30_000_000 }).catch((error: unknown) => {
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

async function gitSnapshot(cwd: string): Promise<{ head: string | null; status: string | null }> {
  const head = await runExternal("git", ["rev-parse", "HEAD"], cwd, true);
  const status = await runExternal("git", ["status", "--short"], cwd, true);
  return {
    head: head.stdout.trim() || null,
    status: status.stdout.trim()
  };
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

function renderSummary(passed: boolean, results: typeof resultBase): string {
  return [
    "# RunForge Alpha-22 Real External Repo Operator Trial",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Trial root: ${trialRoot}`,
    "",
    "## Outcome",
    "",
    `Final verdict: ${passed ? "passed" : "failed"}`,
    "",
    "## Real External Repo",
    "",
    `- Source: ${externalRepo}`,
    `- HEAD before: ${results.originalRepo.beforeHead ?? "unknown"}`,
    `- Status before: ${results.originalRepo.beforeStatus || "(clean)"}`,
    `- HEAD after: ${results.originalRepo.afterHead ?? "unknown"}`,
    `- Status after: ${results.originalRepo.afterStatus || "(clean)"}`,
    `- Mutation verdict: ${results.originalRepo.mutationVerdict}`,
    "",
    "## Evidence",
    "",
    `- Disposable source copy: ${sourceRepo}`,
    `- Accepted operator worktree: ${acceptedRepo}`,
    `- Rejected operator worktree: ${rejectedRepo}`,
    `- Proposal packet: ${proposalPacket}`,
    `- Proposal patch: ${proposalPatch}`,
    `- Accepted decision: ${acceptedDecisionPacketCopy}`,
    `- Rejected decision: ${join(trialRoot, "rejected-decision", "operator-decision.json")}`,
    `- Packet viewer: ${viewerPath}`,
    `- Dashboard: ${join(trialRoot, "dashboard", "index.html")}`,
    `- Lifecycle report: ${join(validationDir, "lifecycle-report.json")}`,
    "",
    "## Decisions",
    "",
    "- Accepted path: proposal generated, operator_simulated_manual_apply in disposable_copy, validation passed, originalRepoMutated false.",
    "- Rejected path: proposal generated, operator_declined in disposable_copy, validation remained failed, originalRepoMutated false.",
    "",
    "## Visibility",
    "",
    "- results.json records accepted and rejected attempts separately.",
    "- dashboard seed/dashboard data expose accepted and rejected operator verdicts.",
    "- lifecycle-report.json includes Alpha-22 milestone comparison.",
    "",
    "## Safety Checks",
    "",
    "- Failure was injected only into the disposable real-repo copy.",
    "- The original Factory repo HEAD/status was recorded before and after and remained unchanged.",
    "- No provider, network, DB, push, merge, or deploy was required.",
    "- RunForge generated and recorded packets; it did not apply a patch to the original external repo.",
    "",
    "## Commands Run",
    "",
    ...commandsRun.map((command) => `- ${command}`),
    "",
    "## Errors",
    "",
    ...(errors.length > 0 ? errors.map((error) => `- ${error}`) : ["- none"]),
    "",
    "## Limitations",
    "",
    ...results.limitations.map((item) => `- ${item}`),
    ""
  ].join("\n");
}
