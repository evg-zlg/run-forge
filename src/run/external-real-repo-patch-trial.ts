import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { writeJson, writeText } from "../core/artifact-store.js";
import { gitSnapshot, mutationVerdictFor } from "./external-command-check-git.js";
import { runExternalCodeProposal } from "./external-code-proposal.js";
import type { ExternalPatchTrialOptions, ExternalPatchTrialResult } from "./external-operator-patch-trial.js";

const defaultRealRepoTrialRoot = "/tmp/runforge-alpha22-real-repo-trial";
const copyExcludeNames = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".next", ".cache"]);

export async function runRealRepoDisposablePatchTrial(options: ExternalPatchTrialOptions): Promise<ExternalPatchTrialResult> {
  if (!options.repo) throw new Error("--repo is required for --mode real-repo-disposable.");
  const originalRepo = resolve(options.repo);
  const root = resolve(options.root ?? options.out ?? join(defaultRealRepoTrialRoot, basename(originalRepo) || "repo"));
  const sourceRepo = join(root, "source-copy");
  const proposalOut = join(root, "proposal-run");
  const runId = options.runId ?? "alpha22-real-repo-operator-trial";
  const originalBefore = await gitSnapshot(originalRepo);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(originalRepo, sourceRepo, {
    recursive: true,
    dereference: false,
    filter: (source) => !copyExcludeNames.has(basename(source))
  });
  await injectAlpha22Failure(sourceRepo);
  const validationCommand = "node runforge-alpha22-verify.cjs";
  const proposal = await runExternalCodeProposal({
    repo: sourceRepo,
    commands: [validationCommand],
    out: proposalOut,
    runId,
    setupNetworkIntent: "none"
  });
  const originalAfter = await gitSnapshot(originalRepo);
  const proposalPatch = join(proposal.packetDir, "proposal.patch");
  const operatorInstructions = join(root, "operator-instructions.md");
  await writeJson(join(proposal.packetDir, "real-repo-trial.json"), {
    schemaVersion: "alpha-22-real-repo-disposable-trial",
    runId: proposal.runId,
    mode: "real-repo-disposable",
    originalRepo,
    disposableSourceRepo: sourceRepo,
    validationCommand,
    failureInjectedOnlyIntoDisposableCopy: true,
    originalRepoBefore: originalBefore,
    originalRepoAfter: originalAfter,
    originalRepoMutationVerdict: mutationVerdictFor(originalBefore, originalAfter),
    proposalPacket: proposal.packetDir,
    proposalPatch,
    runforgeAppliedPatchToOriginalRepo: false,
    providerCallsRequired: false,
    networkRequired: false
  });
  const instructions = renderRealRepoOperatorInstructions({ sourceRepo, proposalPacket: proposal.packetDir, proposalPatch, root, validationCommand, originalRepo });
  await writeText(operatorInstructions, instructions);
  await writeText(join(proposal.packetDir, "operator-instructions.md"), instructions);
  return {
    runId: proposal.runId,
    root,
    sourceRepo,
    originalRepo,
    originalRepoHeadBefore: originalBefore.head,
    originalRepoHeadAfter: originalAfter.head,
    originalRepoStatusBefore: originalBefore.status,
    originalRepoStatusAfter: originalAfter.status,
    proposalPacket: proposal.packetDir,
    proposalPatch,
    operatorInstructions,
    outcome: proposal.outcome,
    verificationPassed: proposal.verificationPassed,
    originalRepoMutationVerdict: mutationVerdictFor(originalBefore, originalAfter),
    failureMode: "injected_into_disposable_copy",
    validationCommand
  };
}

async function injectAlpha22Failure(sourceRepo: string): Promise<void> {
  await mkdir(join(sourceRepo, "runforge-alpha22"), { recursive: true });
  await writeFile(join(sourceRepo, "runforge-alpha22", "math.cjs"), [
    "function add(a, b) {",
    "  return a + b + 1;",
    "}",
    "",
    "module.exports = { add };",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(sourceRepo, "runforge-alpha22-verify.cjs"), [
    "const { add } = require('./runforge-alpha22/math.cjs');",
    "",
    "const actual = add(2, 2);",
    "if (actual !== 4) {",
    "  console.error('AssertionError: alpha22 disposable real repo injected failure');",
    "  console.error('Expected: 4');",
    "  console.error(`Received: ${actual}`);",
    "  process.exit(1);",
    "}",
    "console.log('alpha22 disposable verification passed');",
    ""
  ].join("\n"), "utf8");
}

function renderRealRepoOperatorInstructions(input: { sourceRepo: string; proposalPacket: string; proposalPatch: string; root: string; validationCommand: string; originalRepo: string }): string {
  const operatorRepo = join(input.root, "operator-worktree");
  return [
    "# Alpha-22 Real Repo Disposable Operator Patch Trial",
    "",
    "RunForge generated a proposal packet and did not apply the patch to the source repository.",
    "",
    `Original external repo: ${input.originalRepo}`,
    "The failure was injected only into the disposable source copy for this trial.",
    "",
    "Manual operator loop:",
    "",
    `1. Create a disposable operator worktree, for example: \`cp -R ${input.sourceRepo} ${operatorRepo}\``,
    `2. Apply the proposal manually in that disposable worktree: \`cd ${operatorRepo} && git apply ${input.proposalPatch}\``,
    `3. Rerun validation manually or through the record-decision command: \`${input.validationCommand}\``,
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
