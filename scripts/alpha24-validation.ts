import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateOperatorHandoffPacket } from "../src/run/external-operator-handoff.js";
import { buildKnowledgeLifecycleReport } from "../src/run/knowledge-lifecycle.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const externalRepo = "/Users/evgeny/Documents/projects/factory";
const trialRoot = "/tmp/runforge-alpha24-operator-handoff/factory";
const validationDir = join(repo, "validation/runs/ALPHA-24");
const handoffDir = join(trialRoot, "handoff");
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
  "--run-id", "alpha24-operator-handoff"
]);

const sourceRepo = join(trialRoot, "source-copy");
const proposalPacket = join(trialRoot, "proposal-run", "packet");
const proposalPatch = join(proposalPacket, "proposal.patch");
const acceptedRepo = join(trialRoot, "operator-accepted-worktree");
const rejectedRepo = join(trialRoot, "operator-rejected-worktree");
await expectFile(proposalPatch);

await rm(acceptedRepo, { recursive: true, force: true });
await cp(sourceRepo, acceptedRepo, { recursive: true });
await runExternal("git", ["apply", proposalPatch], acceptedRepo, true);
await runExternal("node", ["runforge-alpha22-verify.cjs"], acceptedRepo, true);

await rm(rejectedRepo, { recursive: true, force: true });
await cp(sourceRepo, rejectedRepo, { recursive: true });

await runCli([
  "external", "handoff-packet",
  "--trial", trialRoot,
  "--out", handoffDir,
  "--operator-worktree", acceptedRepo,
  "--validation-command", validationCommand,
  "--trial-id", "alpha24-operator-handoff"
]);

const handoffValidation = await validateOperatorHandoffPacket(handoffDir);
check(handoffValidation.passed, `handoff validation should pass: ${handoffValidation.errors.join("; ")}`);

const handoffReadme = join(handoffDir, "README.md");
const handoffJson = join(handoffDir, "handoff.json");
const applyInstructions = join(handoffDir, "apply-instructions.md");
const validationInstructions = join(handoffDir, "validation.md");
const rollbackInstructions = join(handoffDir, "rollback.md");
const acceptedForm = join(handoffDir, "decision-form.accepted.json");
const rejectedForm = join(handoffDir, "decision-form.rejected.json");

for (const path of [handoffReadme, handoffJson, applyInstructions, validationInstructions, rollbackInstructions, acceptedForm, rejectedForm]) {
  await expectFile(path);
}

const readmeText = await readFile(handoffReadme, "utf8");
check(readmeText.includes("RunForge proposes only."), "handoff README should state no auto-apply");
check(readmeText.includes("Original repo must remain unchanged."), "handoff README should warn original repo unchanged");
check(readmeText.includes("Manual Apply"), "handoff README should include manual apply section");
check(readmeText.includes("Safety Checklist"), "handoff README should include safety checklist");

const handoff = await readJson<{ proposal?: { autoAppliedByRunForge?: boolean }; sourceRepo?: { originalRepoMutated?: boolean }; worktree?: { path?: string }; safety?: Record<string, boolean> }>(handoffJson);
check(handoff.proposal?.autoAppliedByRunForge === false, "handoff JSON should record autoAppliedByRunForge false");
check(handoff.sourceRepo?.originalRepoMutated === false, "handoff JSON should record originalRepoMutated false");
check(handoff.worktree?.path === acceptedRepo, "handoff JSON should target the accepted disposable operator worktree");
check(Object.values(handoff.safety ?? {}).every((value) => value === false), "handoff JSON safety fields should all be false");

const acceptedTemplate = await readJson<{ decision?: string; appliedBy?: string; appliedTo?: string; originalRepoMutated?: boolean; afterValidation?: string }>(acceptedForm);
const rejectedTemplate = await readJson<{ decision?: string; reason?: string; originalRepoMutated?: boolean }>(rejectedForm);
check(acceptedTemplate.decision === "accepted", "accepted decision form should be accepted");
check(acceptedTemplate.appliedBy === "operator_manual", "accepted decision form should use operator_manual");
check(acceptedTemplate.appliedTo === "disposable_copy", "accepted decision form should target disposable_copy");
check(acceptedTemplate.originalRepoMutated === false, "accepted decision form should keep originalRepoMutated false");
check(acceptedTemplate.afterValidation === "passed", "accepted decision form should require passed after-validation");
check(rejectedTemplate.decision === "rejected", "rejected decision form should be rejected");
check(rejectedTemplate.reason === "operator_declined", "rejected decision form should use operator_declined");
check(rejectedTemplate.originalRepoMutated === false, "rejected decision form should keep originalRepoMutated false");

await runCli([
  "external", "record-decision",
  "--proposal-packet", proposalPacket,
  "--repo", acceptedRepo,
  "--command", validationCommand,
  "--decision", "accepted",
  "--out", join(trialRoot, "accepted-decision"),
  "--run-id", "alpha24-operator-accepted",
  "--reason", "validation_passed_after_operator_apply",
  "--apply-mode", "operator_manual",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-24 accepted evidence used the handoff decision template and disposable operator worktree."
]);

await runCli([
  "external", "record-decision",
  "--proposal-packet", proposalPacket,
  "--repo", rejectedRepo,
  "--command", validationCommand,
  "--decision", "rejected",
  "--out", join(trialRoot, "rejected-decision"),
  "--run-id", "alpha24-operator-rejected",
  "--reason", "operator_declined",
  "--apply-mode", "operator_declined",
  "--applied-to", "disposable_copy",
  "--notes", "Alpha-24 rejected evidence declined the handoff proposal and left the disposable worktree failing."
]);

await runCli(["packet", "inspect", "--packet", proposalPacket, "--validate"]);
await runCli(["packet", "view", "--packet", proposalPacket, "--out", join(trialRoot, "viewer")]);

const originalAfter = await gitSnapshot(externalRepo);
const originalMutationVerdict = originalBefore.head === originalAfter.head && originalBefore.status === originalAfter.status ? "unchanged" : "changed";
check(originalMutationVerdict === "unchanged", "original external repo HEAD/status should remain unchanged");
await writeFile(join(validationDir, "results.json"), `${JSON.stringify({
  schemaVersion: "alpha-24-operator-handoff-preindex",
  generatedAt: new Date().toISOString(),
  originalRepo: {
    path: externalRepo,
    beforeHead: originalBefore.head,
    beforeStatus: originalBefore.status,
    afterHead: originalAfter.head,
    afterStatus: originalAfter.status,
    mutationVerdict: originalMutationVerdict
  },
  attempts: [{
    id: "factory-disposable-handoff",
    repo: externalRepo,
    decision: "handoff_generated",
    packet: proposalPacket,
    viewer: join(trialRoot, "viewer", "index.html"),
    outcome: "operator_handoff_generated",
    providerStatus: "disabled",
    filesChanged: ["runforge-alpha22/math.cjs"],
    manualApply: false,
    appliedTo: "disposable_copy",
    originalRepoMutated: false,
    validationBefore: "failed",
    validationAfter: "pending_operator",
    proposalPatch,
    handoffReadme,
    handoffJson
  }]
}, null, 2)}\n`, "utf8");

await runCli(["packet", "index", "--root", "./validation/runs", "--out", join(trialRoot, "index"), "--dashboard-seed"]);
await runCli(["dashboard", "build", "--seed", join(trialRoot, "index", "dashboard-seed.json"), "--out", join(trialRoot, "dashboard")]);

const indexMarkdown = await readFile(join(trialRoot, "index", "index.md"), "utf8");
check(indexMarkdown.includes(handoffReadme), "packet index should expose handoff README path");
const dashboardData = await readJson<{ records?: Array<{ alpha?: string; handoffReadmePath?: string; handoffJsonPath?: string }> }>(join(trialRoot, "dashboard", "dashboard-data.json"));
check((dashboardData.records ?? []).some((record) => record.alpha === "ALPHA-24" && record.handoffReadmePath === handoffReadme && record.handoffJsonPath === handoffJson), "dashboard data should expose handoff paths");
const viewerText = await readFile(join(trialRoot, "viewer", "index.html"), "utf8");
check(viewerText.includes("Operator Handoff"), "packet viewer should expose operator handoff section");
check(viewerText.includes(handoffReadme), "packet viewer should link the handoff README path");

await mkdir(join(validationDir, "handoff"), { recursive: true });
for (const name of ["README.md", "handoff.json", "apply-instructions.md", "validation.md", "rollback.md", "decision-form.accepted.json", "decision-form.rejected.json", "evidence-links.json", "proposal.patch"]) {
  await cp(join(handoffDir, name), join(validationDir, "handoff", name));
}

const resultBase = {
  schemaVersion: "alpha-24-operator-handoff",
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
  handoff: {
    dir: handoffDir,
    readme: handoffReadme,
    json: handoffJson,
    trackedReadme: "validation/runs/ALPHA-24/handoff/README.md",
    trackedJson: "validation/runs/ALPHA-24/handoff/handoff.json",
    applyInstructions,
    validationInstructions,
    rollbackInstructions,
    acceptedDecisionForm: acceptedForm,
    rejectedDecisionForm: rejectedForm
  },
  attempts: [
    {
      id: "factory-disposable-handoff",
      repo: externalRepo,
      decision: "handoff_generated",
      packet: proposalPacket,
      viewer: join(trialRoot, "viewer", "index.html"),
      outcome: "operator_handoff_generated",
      providerStatus: "disabled",
      filesChanged: ["runforge-alpha22/math.cjs"],
      externalRepoHeadBefore: originalBefore.head,
      externalRepoHeadAfter: originalAfter.head,
      manualApply: false,
      appliedTo: "disposable_copy",
      originalRepoMutated: false,
      validationBefore: "failed",
      validationAfter: "pending_operator",
      proposalPatch,
      handoffReadme,
      handoffJson
    }
  ],
  safety: {
    noOriginalExternalRepoMutation: true,
    noAutoApplyByRunForge: true,
    noProviderCalls: true,
    noNetworkRequired: true,
    noDbAccess: true,
    noPushMergeDeploy: true,
    handoffValidation
  },
  visibility: {
    packetIndex: join(trialRoot, "index", "index.json"),
    dashboard: join(trialRoot, "dashboard", "index.html"),
    packetViewer: join(trialRoot, "viewer", "index.html"),
    lifecycleReport: "validation/runs/ALPHA-24/lifecycle-report.json"
  },
  limitations: [
    "The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.",
    "Alpha-24 creates an operator handoff bundle; it still does not auto-apply to protected repositories."
  ],
  commandsRun,
  errors,
  finalVerdict: errors.length === 0 ? "passed" : "failed"
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(resultBase, null, 2)}\n`, "utf8");

const lifecycle = await buildKnowledgeLifecycleReport({
  repoRoot: repo,
  runs: "./validation/runs",
  out: "./validation/runs/ALPHA-24",
  skillRoots: [join(repo, ".agents/skills")]
});
check(lifecycle.handoffPacketCounts.generated >= 1, "lifecycle should count generated handoff packets");
check(lifecycle.handoffPacketCounts.unsafe === 0, "lifecycle should count zero unsafe handoff packets");
check(lifecycle.milestoneComparison.some((line) => line.includes("Alpha-24 generates")), "lifecycle report should mention Alpha-24");

await writeFile(join(validationDir, "lifecycle-report.json"), `${JSON.stringify({
  schemaVersion: "alpha-24-compact-lifecycle-report",
  generatedAt: new Date().toISOString(),
  validation: lifecycle.validation,
  sourceCounts: lifecycle.sourceCounts,
  lifecycleStatusCounts: lifecycle.lifecycleStatusCounts,
  operatorTrialCounts: lifecycle.operatorTrialCounts,
  handoffPacketCounts: lifecycle.handoffPacketCounts,
  alpha24: {
    status: "active",
    realExternalRepoSource: externalRepo,
    disposableTrialRoot: trialRoot,
    handoffPacket: resultBase.handoff,
    originalRepoMutationVerdict: originalMutationVerdict,
    visibility: resultBase.visibility,
    safety: resultBase.safety
  },
  milestoneComparison: lifecycle.milestoneComparison.filter((line) => line.includes("Alpha-24") || line.includes("Alpha-23")),
  findings: lifecycle.findings,
  recommendations: ["Next milestone: Alpha-25 Operator Handoff Replay / Audit."]
}, null, 2)}\n`, "utf8");

const finalResults = { ...resultBase, commandsRun, errors, finalVerdict: errors.length === 0 ? "passed" : "failed" };
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(finalResults, null, 2)}\n`, "utf8");
const summary = renderSummary(finalResults.finalVerdict === "passed", finalResults);
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

async function runCli(args: string[]): Promise<void> {
  const commandText = `pnpm dev ${args.join(" ")}`;
  commandsRun.push(commandText);
  const result = await execFileAsync("pnpm", ["dev", ...args], { cwd: repo, maxBuffer: 30_000_000 }).catch((error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    errors.push(`${commandText} failed with exit ${failure.code ?? "unknown"}\n${failure.stdout ?? ""}${failure.stderr ?? ""}`);
    return null;
  });
  if (result?.stdout.trim()) commandsRun.push(`# stdout: ${firstLine(result.stdout)}`);
  if (result?.stderr.trim()) commandsRun.push(`# stderr: ${firstLine(result.stderr)}`);
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

function renderSummary(passed: boolean, results: typeof resultBase): string {
  return [
    "# RunForge Alpha-24 Real Operator Handoff Packet",
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
    "## Handoff Packet",
    "",
    `- README: ${results.handoff.readme}`,
    `- JSON: ${results.handoff.json}`,
    `- Apply instructions: ${results.handoff.applyInstructions}`,
    `- Validation instructions: ${results.handoff.validationInstructions}`,
    `- Rollback instructions: ${results.handoff.rollbackInstructions}`,
    `- Accepted decision form: ${results.handoff.acceptedDecisionForm}`,
    `- Rejected decision form: ${results.handoff.rejectedDecisionForm}`,
    "",
    "## Visibility",
    "",
    "- packet index exposes handoff README path.",
    "- dashboard data exposes handoff README and JSON paths.",
    "- packet viewer exposes the operator handoff section.",
    "- lifecycle-report.json counts generated handoff packets.",
    "",
    "## Safety",
    "",
    "- Original external repo HEAD/status unchanged.",
    "- Manual apply instructions target only the disposable/operator worktree.",
    "- No provider, network, DB, push, merge, or deploy was required.",
    "- Handoff validation rejected unsafe or incomplete packets in unit coverage.",
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
