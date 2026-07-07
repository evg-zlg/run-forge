import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeJson, writeText } from "../core/artifact-store.js";
import { createRunId } from "../core/trajectory.js";
import { runExternalCommandCheck } from "./external-command-check.js";
import { gitSnapshot, mutationVerdictFor } from "./external-command-check-git.js";
import type { ExternalCheckStatus } from "./external-command-check-types.js";
import { runExternalCodeProposal } from "./external-code-proposal.js";
import { commandSummaries, renderDecisionMarkdown } from "./external-operator-patch-renderer.js";
import { runRealRepoDisposablePatchTrial } from "./external-real-repo-patch-trial.js";
import {
  buildOperatorDecisionSummary,
  readPacketValidationState,
  renderOperatorDecisionSummaryMarkdown
} from "./operator-decision-summary.js";

const execFileAsync = promisify(execFile);
const defaultTrialRoot = "/tmp/runforge-alpha21-operator-trial";

export interface ExternalPatchTrialOptions {
  root?: string;
  out?: string;
  runId?: string;
  repo?: string;
  mode?: "controlled-fixture" | "real-repo-disposable";
}

export interface ExternalPatchTrialResult {
  runId: string;
  root: string;
  sourceRepo: string;
  originalRepo?: string;
  originalRepoHeadBefore?: string | null;
  originalRepoHeadAfter?: string | null;
  originalRepoStatusBefore?: string | null;
  originalRepoStatusAfter?: string | null;
  proposalPacket: string;
  proposalPatch: string;
  operatorInstructions: string;
  outcome: string;
  verificationPassed: boolean;
  originalRepoMutationVerdict: string;
  failureMode: "controlled_fixture" | "injected_into_disposable_copy";
  validationCommand: string;
}

export type OperatorDecision = "accepted" | "rejected";

export interface ExternalRecordDecisionOptions {
  proposalPacket: string;
  repo: string;
  commands: string[];
  decision: OperatorDecision;
  out?: string;
  runId?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  notes?: string;
  reason?: string;
  applyMode?: string;
  appliedTo?: string;
}

export interface ExternalRecordDecisionResult {
  runId: string;
  decision: OperatorDecision;
  finalOutcome: "accepted" | "rejected";
  decisionDir: string;
  decisionPath: string;
  operatorSummaryPath: string;
  validationPacket: string;
  validationStatus: ExternalCheckStatus;
  validationPassed: boolean;
  repoMutationVerdict: string;
}

export async function runExternalPatchTrial(options: ExternalPatchTrialOptions): Promise<ExternalPatchTrialResult> {
  if (options.mode === "real-repo-disposable" || options.repo) return runRealRepoDisposablePatchTrial(options);
  const root = resolve(options.root ?? defaultTrialRoot);
  const sourceRepo = join(root, "source");
  const out = resolve(options.out ?? join(root, "proposal-run"));
  const runId = options.runId ?? "alpha21-operator-patch-trial";
  await createAlpha21Fixture(sourceRepo);
  const proposal = await runExternalCodeProposal({
    repo: sourceRepo,
    commands: ["node verify.js"],
    out,
    runId,
    setupNetworkIntent: "none"
  });
  const proposalPatch = join(proposal.packetDir, "proposal.patch");
  const operatorInstructions = join(root, "operator-instructions.md");
  await writeText(operatorInstructions, renderOperatorInstructions({
    sourceRepo,
    proposalPacket: proposal.packetDir,
    proposalPatch,
    root
  }));
  await writeText(join(proposal.packetDir, "operator-instructions.md"), renderOperatorInstructions({
    sourceRepo,
    proposalPacket: proposal.packetDir,
    proposalPatch,
    root
  }));
  return {
    runId: proposal.runId,
    root,
    sourceRepo,
    proposalPacket: proposal.packetDir,
    proposalPatch,
    operatorInstructions,
    outcome: proposal.outcome,
    verificationPassed: proposal.verificationPassed,
    originalRepoMutationVerdict: proposal.originalRepoMutationVerdict,
    failureMode: "controlled_fixture",
    validationCommand: "node verify.js"
  };
}

export async function recordExternalPatchDecision(options: ExternalRecordDecisionOptions): Promise<ExternalRecordDecisionResult> {
  if (options.commands.length === 0) throw new Error("--command is required at least once.");
  const runId = options.runId ?? createRunId();
  const startedAt = new Date().toISOString();
  const proposalPacket = resolve(options.proposalPacket);
  const repo = resolve(options.repo);
  const decisionDir = resolve(options.out ?? join(proposalPacket, "operator-decision"));
  await mkdir(decisionDir, { recursive: true });

  const before = await gitSnapshot(repo);
  const validation = await runExternalCommandCheck({
    repo,
    commands: options.commands,
    out: join(decisionDir, "validation-rerun"),
    runId: `${runId}-validation`,
    setupNetworkIntent: "none",
    timeoutMs: options.timeoutMs,
    maxLogBytes: options.maxLogBytes
  });
  const after = await gitSnapshot(repo);
  const validationPassed = validation.status === "passed" && validation.commandResults.every((result) => result.status === "passed");
  const repoMutationVerdict = mutationVerdictFor(before, after);
  const finishedAt = new Date().toISOString();
  const finalOutcome: "accepted" | "rejected" = options.decision === "accepted" && validationPassed ? "accepted" : "rejected";
  const proposalPatch = join(proposalPacket, "proposal.patch");
  const record = {
    schemaVersion: "alpha-21-operator-decision",
    runId,
    proposalPacket,
    proposalPatch,
    repo,
    decision: options.decision,
    finalOutcome,
    reason: options.reason ?? (finalOutcome === "rejected" && options.decision === "accepted" ? "validation_failed_after_apply" : ""),
    notes: options.notes ?? "",
    validation: {
      packet: validation.packetDir,
      status: validation.status,
      passed: validationPassed,
      commands: commandSummaries(validation.commandResults)
    },
    manualApplyRequired: true,
    manualApplyVerifiedByRerun: validationPassed,
    apply: {
      mode: options.applyMode ?? "operator_simulated_manual_apply",
      appliedTo: options.appliedTo ?? "disposable_copy",
      originalRepoMutated: false as const
    },
    runforgeAppliedPatch: false as const,
    safety: {
      providerUsed: false as const,
      networkUsed: false as const,
      dbUsed: false as const,
      deployUsed: false as const,
      pushUsed: false as const,
      mergeUsed: false as const
    },
    originalExternalRepoProtected: true,
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    repoMutationVerdictDuringDecision: repoMutationVerdict,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  };
  const markdown = renderDecisionMarkdown(record);
  const decisionPath = join(decisionDir, "operator-decision.json");
  const packetValidation = await readPacketValidationState(proposalPacket);
  const summary = buildOperatorDecisionSummary({
    trialId: runId,
    sourcePath: repo,
    sourceHeadBefore: before.head,
    sourceHeadAfter: after.head,
    sourceStatusBefore: before.status,
    sourceStatusAfter: after.status,
    originalRepoMutated: false,
    proposalOutcome: packetValidation.proposalOutcome,
    proposalPacket,
    proposalPatch,
    decisionVerdict: finalOutcome,
    appliedBy: record.apply.mode,
    appliedTo: record.apply.appliedTo,
    reason: record.reason,
    decisionPath,
    validationBefore: packetValidation.before,
    validationAfter: validationPassed ? "passed" : "failed",
    beforeCommand: packetValidation.beforeCommand,
    afterCommand: options.commands.join(" && ")
  });
  const operatorSummaryPath = join(decisionDir, "operator-summary.md");
  await writeJson(decisionPath, record);
  await writeText(join(decisionDir, "operator-decision.md"), markdown);
  await writeJson(join(decisionDir, "operator-summary.json"), summary);
  await writeText(operatorSummaryPath, renderOperatorDecisionSummaryMarkdown(summary));
  await writeJson(join(proposalPacket, "operator-decision.json"), record);
  await writeText(join(proposalPacket, "operator-decision.md"), markdown);
  await writeJson(join(proposalPacket, "operator-summary.json"), summary);
  await writeText(join(proposalPacket, "operator-summary.md"), renderOperatorDecisionSummaryMarkdown(summary));
  return {
    runId,
    decision: options.decision,
    finalOutcome,
    decisionDir,
    decisionPath,
    operatorSummaryPath,
    validationPacket: validation.packetDir,
    validationStatus: validation.status,
    validationPassed,
    repoMutationVerdict
  };
}

export function renderExternalPatchTrialSummary(result: ExternalPatchTrialResult): string {
  return [
    `Patch trial source: ${result.sourceRepo}`,
    ...(result.originalRepo ? [
      `Original repo: ${result.originalRepo}`,
      `Original repo HEAD before: ${result.originalRepoHeadBefore ?? "unknown"}`,
      `Original repo HEAD after: ${result.originalRepoHeadAfter ?? "unknown"}`,
      `Original repo status before: ${result.originalRepoStatusBefore || "(clean)"}`,
      `Original repo status after: ${result.originalRepoStatusAfter || "(clean)"}`,
      `Failure mode: ${result.failureMode}`
    ] : []),
    `Proposal packet: ${result.proposalPacket}`,
    `Proposal patch: ${result.proposalPatch}`,
    `Operator instructions: ${result.operatorInstructions}`,
    `Outcome: ${result.outcome}`,
    `Verification passed in disposable proposal workspace: ${result.verificationPassed}`,
    `Original fixture repo mutation verdict: ${result.originalRepoMutationVerdict}`,
    "RunForge did not apply the patch to the source repo."
  ].join("\n");
}

export function renderExternalRecordDecisionSummary(result: ExternalRecordDecisionResult): string {
  return [
    `Operator decision recorded: ${result.finalOutcome}`,
    `Requested decision: ${result.decision}`,
    `Decision artifact: ${result.decisionPath}`,
    `Operator summary: ${result.operatorSummaryPath}`,
    `Validation packet: ${result.validationPacket}`,
    `Validation status: ${result.validationStatus}`,
    `Validation passed: ${result.validationPassed}`,
    `Decision repo mutation verdict during rerun: ${result.repoMutationVerdict}`,
    "RunForge recorded the manual decision; it did not apply, push, merge, or deploy the patch."
  ].join("\n");
}

async function createAlpha21Fixture(sourceRepo: string): Promise<void> {
  await rm(sourceRepo, { recursive: true, force: true });
  await mkdir(join(sourceRepo, "src"), { recursive: true });
  await writeFile(join(sourceRepo, "package.json"), `${JSON.stringify({
    name: "runforge-alpha21-operator-trial",
    private: true,
    scripts: { verify: "node verify.js" }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(sourceRepo, "src/math.js"), [
    "function add(a, b) {",
    "  return a + b + 1;",
    "}",
    "",
    "module.exports = { add };",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(sourceRepo, "verify.js"), [
    "const { add } = require('./src/math');",
    "",
    "const actual = add(2, 2);",
    "if (actual !== 4) {",
    "  console.error('AssertionError: add(2, 2)');",
    "  console.error('Expected: 4');",
    "  console.error(`Received: ${actual}`);",
    "  process.exit(1);",
    "}",
    "console.log('verification passed');",
    ""
  ].join("\n"), "utf8");
  await execGit(["init"], sourceRepo);
  await execGit(["config", "user.email", "runforge@example.invalid"], sourceRepo);
  await execGit(["config", "user.name", "RunForge Alpha21"], sourceRepo);
  await execGit(["add", "."], sourceRepo);
  await execGit(["commit", "-m", "Create failing alpha21 fixture"], sourceRepo);
}

async function execGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, maxBuffer: 10_000_000 });
}

function renderOperatorInstructions(input: { sourceRepo: string; proposalPacket: string; proposalPatch: string; root: string; title?: string; validationCommand?: string; originalRepo?: string }): string {
  const operatorRepo = join(input.root, "operator-worktree");
  const validationCommand = input.validationCommand ?? "node verify.js";
  return [
    `# ${input.title ?? "Alpha-21 Operator Patch Trial"}`,
    "",
    "RunForge generated a proposal packet and did not apply the patch to the source repository.",
    ...(input.originalRepo ? [
      "",
      `Original external repo: ${input.originalRepo}`,
      "The failure was injected only into the disposable source copy for this trial."
    ] : []),
    "",
    "Manual operator loop:",
    "",
    `1. Create a disposable operator worktree, for example: \`cp -R ${input.sourceRepo} ${operatorRepo}\``,
    `2. Apply the proposal manually in that disposable worktree: \`cd ${operatorRepo} && git apply ${input.proposalPatch}\``,
    `3. Rerun validation manually or through the record-decision command: \`${validationCommand}\``,
    "4. Record the accepted or rejected decision with `runforge external record-decision`.",
    "",
    "Safety boundary:",
    "",
    "- Do not apply this patch to the original external repo.",
    "- Do not push, merge, deploy, or call providers as part of this trial.",
    "- The proposal packet remains review evidence, not an authorization to mutate protected repos.",
    "",
    `Proposal packet: ${input.proposalPacket}`,
    `Proposal patch: ${input.proposalPatch}`,
    ""
  ].join("\n");
}
