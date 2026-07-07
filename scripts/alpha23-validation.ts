import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";
import { validateOperatorDecisionObject } from "../src/run/operator-decision-summary.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const externalRepo = "/Users/evgeny/Documents/projects/factory";
const trialRoot = "/tmp/runforge-alpha23-operator-patch-ux/factory";
const validationDir = join(repo, "validation/runs/ALPHA-23");
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
  "--run-id", "alpha23-operator-patch-ux"
]);

const sourceRepo = join(trialRoot, "source-copy");
const proposalPacket = join(trialRoot, "proposal-run", "packet");
const proposalPatch = join(proposalPacket, "proposal.patch");
await expectFile(proposalPatch);

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
  "--run-id", "alpha23-operator-accepted",
  "--reason", "validation_passed_after_operator_apply",
  "--apply-mode", "operator_simulated_manual_apply",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-23 accepted path manually applied proposal.patch only in the disposable accepted operator worktree."
]);

const acceptedDecision = await readJson<DecisionRecord>(join(proposalPacket, "operator-decision.json"));
const acceptedSummaryPath = join(trialRoot, "accepted-decision", "operator-summary.md");
await expectFile(acceptedSummaryPath);
await cp(join(proposalPacket, "operator-decision.json"), join(trialRoot, "accepted-decision", "accepted-operator-decision.json"));
await cp(join(proposalPacket, "operator-summary.json"), join(trialRoot, "accepted-decision", "accepted-operator-summary.json"));
const acceptedSummaryText = await readFile(acceptedSummaryPath, "utf8");
check(acceptedDecision.finalOutcome === "accepted", "accepted operator decision should be accepted");
check(acceptedDecision.validation?.passed === true, "accepted decision validation should pass");
check(acceptedDecision.apply?.originalRepoMutated === false, "accepted decision must record originalRepoMutated false");
check(acceptedDecision.runforgeAppliedPatch === false, "accepted decision must record runforgeAppliedPatch false");
check(acceptedSummaryText.includes("Manual Apply Boundary"), "accepted summary should include manual boundary");
check(acceptedSummaryText.includes("RunForge auto-applied patch: false"), "accepted summary should show auto-apply false");

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
  "--run-id", "alpha23-operator-rejected",
  "--reason", "operator_declined",
  "--apply-mode", "operator_declined",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-23 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree."
]);

const rejectedDecision = await readJson<DecisionRecord>(join(proposalPacket, "operator-decision.json"));
const rejectedSummaryPath = join(trialRoot, "rejected-decision", "operator-summary.md");
await expectFile(rejectedSummaryPath);
const rejectedSummaryText = await readFile(rejectedSummaryPath, "utf8");
check(rejectedDecision.finalOutcome === "rejected", "rejected operator decision should be rejected");
check(rejectedDecision.reason === "operator_declined", "rejected decision should record operator_declined");
check(rejectedDecision.validation?.passed === false, "rejected decision validation should fail");
check(rejectedDecision.apply?.originalRepoMutated === false, "rejected decision must record originalRepoMutated false");
check(rejectedSummaryText.includes("Decision: rejected"), "rejected summary should be first-class decision evidence");
check(rejectedSummaryText.includes("Next action:"), "rejected summary should include next action");

const safetyLint = runSafetyLintChecks();
check(safetyLint.passed, `safety lint checks should pass: ${safetyLint.errors.join("; ")}`);

await runCli(["packet", "inspect", "--packet", proposalPacket, "--validate"]);
await runCli(["packet", "view", "--packet", proposalPacket, "--out", join(trialRoot, "viewer")]);

const proposalStatus = await readJson<{ outcome?: string; providerStatus?: string; filesChanged?: string[] }>(join(proposalPacket, "proposal-status.json"));
check(proposalStatus.outcome === "proposal_ready_verified", "proposal should be verified");
check((proposalStatus.filesChanged ?? []).includes("runforge-alpha22/math.cjs"), "proposal should touch injected disposable source file");

const originalAfter = await gitSnapshot(externalRepo);
const originalMutationVerdict = originalBefore.head === originalAfter.head && originalBefore.status === originalAfter.status ? "unchanged" : "changed";
check(originalMutationVerdict === "unchanged", "original external repo HEAD/status should remain unchanged");

const viewerPath = join(trialRoot, "viewer", "index.html");
await expectFile(viewerPath);
const viewerText = await readFile(viewerPath, "utf8");
check(viewerText.includes("Operator Decision"), "packet viewer should expose operator decision");
check(viewerText.includes("Applied to"), "packet viewer should expose appliedTo");
check(viewerText.includes("Auto-apply by RunForge"), "packet viewer should expose auto-apply state");

const operatorSummaryPath = join(validationDir, "operator-summary.md");
const acceptedDecisionEvidence = join(trialRoot, "accepted-decision", "accepted-operator-decision.json");
const acceptedSummaryEvidence = join(trialRoot, "accepted-decision", "accepted-operator-summary.json");
const rejectedDecisionEvidence = join(trialRoot, "rejected-decision", "operator-decision.json");

const resultBase = {
  schemaVersion: "alpha-23-operator-patch-ux",
  generatedAt: new Date().toISOString(),
  trialRoot,
  originalRepo: {
    path: externalRepo,
    beforeHead: originalBefore.head,
    beforeStatus: originalBefore.status,
    afterHead: originalAfter.head,
    afterStatus: originalAfter.status,
    mutationVerdict: originalMutationVerdict
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
  operatorSummary: operatorSummaryPath,
  decisions: {
    accepted: acceptedDecisionEvidence,
    rejected: rejectedDecisionEvidence
  },
  summaries: {
    accepted: acceptedSummaryPath,
    acceptedJson: acceptedSummaryEvidence,
    rejected: rejectedSummaryPath
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
      reason: acceptedDecision.reason,
      packet: proposalPacket,
      viewer: viewerPath,
      outcome: "workflow_succeeded_operator_accepted",
      providerStatus: proposalStatus.providerStatus ?? "disabled",
      filesChanged: proposalStatus.filesChanged ?? [],
      externalRepoHeadBefore: originalBefore.head,
      externalRepoHeadAfter: originalAfter.head,
      manualApply: true,
      appliedTo: "disposable_copy",
      originalRepoMutated: false,
      validationBefore: "failed",
      validationAfter: "passed",
      proposalPatch
    },
    {
      id: "factory-disposable-rejected",
      repo: externalRepo,
      decision: "rejected",
      operatorDecision: rejectedDecision.finalOutcome,
      reason: rejectedDecision.reason,
      packet: proposalPacket,
      viewer: viewerPath,
      outcome: "workflow_succeeded_operator_rejected",
      providerStatus: proposalStatus.providerStatus ?? "disabled",
      filesChanged: proposalStatus.filesChanged ?? [],
      externalRepoHeadBefore: originalBefore.head,
      externalRepoHeadAfter: originalAfter.head,
      manualApply: false,
      appliedTo: "disposable_copy",
      originalRepoMutated: false,
      validationBefore: "failed",
      validationAfter: "failed",
      proposalPatch
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
    noPushMergeDeploy: true,
    safetyLint
  },
  visibility: {
    operatorSummary: "validation/runs/ALPHA-23/operator-summary.md",
    evidenceResults: "validation/runs/ALPHA-23/results.json",
    evidenceSummary: "validation/runs/ALPHA-23/summary.md",
    lifecycleReport: "validation/runs/ALPHA-23/lifecycle-report.json",
    packetIndex: join(trialRoot, "index", "index.json"),
    dashboard: join(trialRoot, "dashboard", "index.html"),
    packetViewer: viewerPath
  },
  limitations: [
    "The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.",
    "Alpha-23 improves operator UX and safety lint; it still does not authorize auto-apply to protected repositories."
  ],
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(resultBase, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(trialRoot, "index"), "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(trialRoot, "index", "dashboard-seed.json"), "--out", join(trialRoot, "dashboard")]);

const indexMarkdown = await readFile(join(trialRoot, "index", "index.md"), "utf8");
check(indexMarkdown.includes("workflow_succeeded_operator_accepted"), "packet index should expose accepted workflow outcome");
check(indexMarkdown.includes("workflow_succeeded_operator_rejected"), "packet index should expose rejected workflow outcome");
check(indexMarkdown.includes("failed->passed"), "packet index should expose before/after validation");

const dashboardData = await readJson<{ records?: Array<{ alpha?: string; operatorVerdict?: string; validationBefore?: string; validationAfter?: string; mutationVerdict?: string; proposalPatchPath?: string; notes?: string }> }>(join(trialRoot, "dashboard", "dashboard-data.json"));
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-23" && record.operatorVerdict === "accepted" && record.validationBefore === "failed" && record.validationAfter === "passed"), "dashboard data should expose accepted Alpha-23 validation transition");
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-23" && record.operatorVerdict === "rejected" && record.validationBefore === "failed" && record.validationAfter === "failed"), "dashboard data should expose rejected Alpha-23 validation transition");
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-23" && record.mutationVerdict === "unchanged" && record.proposalPatchPath === proposalPatch), "dashboard data should expose mutation verdict and patch path");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-23",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.validation.ok, `lifecycle validation should pass: ${lifecycle.validation.errors.join("; ")}`);
check(lifecycle.operatorTrialCounts.accepted >= 1, "lifecycle should count accepted operator trials");
check(lifecycle.operatorTrialCounts.rejected >= 1, "lifecycle should count rejected operator trials");
check(lifecycle.operatorTrialCounts.unsafeMutation === 0, "lifecycle should count zero unsafe operator mutations");
check(lifecycle.milestoneComparison.some((line) => line.includes("Alpha-23 hardens")), "lifecycle report should mention Alpha-23");

const operatorSummary = renderOperatorSummary(resultBase);
await writeFile(operatorSummaryPath, operatorSummary, "utf8");
await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-23-compact-lifecycle-report",
  generatedAt: new Date().toISOString(),
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  operatorTrialCounts: lifecycle.operatorTrialCounts,
  alpha23: {
    status: "active",
    realExternalRepoSource: externalRepo,
    disposableTrialRoot: trialRoot,
    acceptedDecisions: 1,
    rejectedDecisions: 1,
    missingDecisions: 0,
    unsafeMutations: 0,
    originalRepoMutationVerdict: resultBase.originalRepo.mutationVerdict,
    visibility: resultBase.visibility,
    safety: resultBase.safety
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-23") || line.includes("Alpha-22") || line.includes("Alpha-21")),
  findings: lifecycle.findings,
  recommendations: ["Next milestone: Alpha-24 Real Operator Handoff Packet."]
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
  runforgeAppliedPatch?: boolean;
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

async function gitSnapshot(cwd: string): Promise<{ head: string | null; status: string }> {
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

function runSafetyLintChecks(): { passed: boolean; cases: string[]; errors: string[] } {
  const base = {
    proposalPacket,
    proposalPatch,
    decision: "accepted",
    finalOutcome: "accepted",
    reason: "validation_passed_after_operator_apply",
    validation: { passed: true, status: "passed", packet: "/tmp/runforge-alpha23/validation/packet" },
    apply: { mode: "operator_simulated_manual_apply", appliedTo: "disposable_copy", originalRepoMutated: false },
    runforgeAppliedPatch: false,
    safety: { providerUsed: false, networkUsed: false, dbUsed: false, deployUsed: false, pushUsed: false, mergeUsed: false }
  };
  const cases: Array<{ name: string; record: Record<string, unknown>; expected: string }> = [
    { name: "accepted_original_mutation", record: { ...base, apply: { ...base.apply, originalRepoMutated: true } }, expected: "accepted decision cannot have originalRepoMutated=true" },
    { name: "accepted_missing_after_validation", record: { ...base, validation: {} }, expected: "accepted decision missing after-validation result" },
    { name: "accepted_failed_after_validation", record: { ...base, validation: { passed: false, status: "failed" } }, expected: "accepted decision requires passed after-validation" },
    { name: "rejected_without_reason", record: { ...base, decision: "rejected", finalOutcome: "rejected", reason: "", validation: { passed: false, status: "failed" } }, expected: "rejected decision requires reason" },
    { name: "missing_auto_apply_false", record: { ...base, runforgeAppliedPatch: true }, expected: "missing runforgeAppliedPatch=false" },
    { name: "missing_applied_to", record: { ...base, apply: { mode: "operator_simulated_manual_apply", originalRepoMutated: false } }, expected: "missing apply.appliedTo" },
    { name: "applied_to_original_repo", record: { ...base, apply: { ...base.apply, appliedTo: "original_repo" } }, expected: "apply.appliedTo must not be original_repo" },
    { name: "missing_packet_link", record: { ...base, proposalPacket: "" }, expected: "missing proposalPacket link" },
    { name: "missing_safety_summary", record: { ...base, safety: undefined }, expected: "missing safety summary" }
  ];
  const lintErrors: string[] = [];
  for (const item of cases) {
    const itemErrors = validateOperatorDecisionObject(item.record);
    if (!itemErrors.some((error) => error.includes(item.expected))) lintErrors.push(`${item.name} did not fail with ${item.expected}`);
  }
  return { passed: lintErrors.length === 0, cases: cases.map((item) => item.name), errors: lintErrors };
}

function renderOperatorSummary(results: typeof resultBase): string {
  return [
    "# RunForge Alpha-23 Operator Patch Trial UX Summary",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Original repo: ${externalRepo}`,
    `Original repo mutated: false`,
    `Proposal packet: ${proposalPacket}`,
    `Proposal patch: ${proposalPatch}`,
    "",
    "## Accepted Decision",
    "",
    "- Workflow succeeded, decision accepted.",
    "- Before validation: failed.",
    "- After validation: passed.",
    "- Applied by: operator_simulated_manual_apply.",
    "- Applied to: disposable_copy.",
    "- RunForge auto-applied patch: false.",
    "- Next action: review evidence before any separate manual port to a protected repo.",
    "",
    "## Rejected Decision",
    "",
    "- Workflow succeeded, decision rejected.",
    "- Reason: operator_declined.",
    "- Before validation: failed.",
    "- After validation: failed.",
    "- Applied by: operator_declined.",
    "- Applied to: disposable_copy.",
    "- Next action: keep the original repo unchanged and gather more context or revise the proposal.",
    "",
    "## Safety Checklist",
    "",
    "- Original external repo HEAD/status unchanged.",
    "- No provider, network, DB, push, merge, or deploy was required.",
    "- Safety lint rejected unsafe or misleading decision records.",
    "",
    "## Evidence",
    "",
    `- Accepted decision: ${results.decisions.accepted}`,
    `- Rejected decision: ${results.decisions.rejected}`,
    `- Accepted summary: ${results.summaries.accepted}`,
    `- Rejected summary: ${results.summaries.rejected}`,
    `- Packet viewer: ${viewerPath}`,
    `- Dashboard: ${results.visibility.dashboard}`,
    `- Lifecycle report: ${results.visibility.lifecycleReport}`,
    ""
  ].join("\n");
}

function renderSummary(passed: boolean, results: typeof resultBase): string {
  return [
    "# RunForge Alpha-23 Operator Patch Trial UX Hardening",
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
    "## Operator UX Evidence",
    "",
    `- Operator summary: ${operatorSummaryPath}`,
    `- Accepted decision: ${acceptedDecisionEvidence}`,
    `- Rejected decision: ${rejectedDecisionEvidence}`,
    `- Accepted decision summary: ${acceptedSummaryPath}`,
    `- Rejected decision summary: ${rejectedSummaryPath}`,
    `- Packet viewer: ${viewerPath}`,
    `- Dashboard: ${join(trialRoot, "dashboard", "index.html")}`,
    `- Lifecycle report: ${join(validationDir, "lifecycle-report.json")}`,
    "",
    "## Decisions",
    "",
    "- Accepted path: workflow succeeded, operator_simulated_manual_apply in disposable_copy, validation failed->passed, originalRepoMutated false.",
    "- Rejected path: workflow succeeded, operator_declined in disposable_copy, validation failed->failed, originalRepoMutated false.",
    "",
    "## Visibility",
    "",
    "- packet index exposes decision verdict, before/after validation, applied target, auto-apply false, mutation verdict, and patch path.",
    "- dashboard data exposes accepted/rejected operator verdicts, validation transitions, mutation verdict, and patch path.",
    "- lifecycle-report.json counts accepted/rejected/missing/unsafe operator trials.",
    "- packet viewer exposes the operator decision and summary.",
    "",
    "## Safety Lint",
    "",
    ...results.safety.safetyLint.cases.map((item) => `- ${item}: rejected`),
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
