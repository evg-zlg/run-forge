import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureDir, writeJson, writeText } from "../src/core/artifact-store.js";
import type { RunRecord } from "../src/core/types.js";
import { runRunForge } from "../src/run/run-runner.js";

const execFileAsync = promisify(execFile);
const defaultOutputRoot = "artifacts/mvp-demo/sample-js-fix";
const fixtureFiles = ["package.json", "src/calculator.ts", "tests/calculator.test.ts"];
const deterministicFailureCommand =
  "node -e \"const actual=1+1; const expected=3; if (actual !== expected) { console.error('Expected add(1, 1) to be ' + expected + ', received ' + actual); process.exit(1); }\"";

export interface MvpDemoResult {
  outputRoot: string;
  fixtureRepo: string;
  humanReviewPath: string;
  proposalPatchPath: string;
  patchCheck: { ok: boolean; command: string };
  fixtureUnchanged: boolean;
  rootGitStatus: string;
  childRuns: Array<{ name: string; runId: string; status: RunRecord["status"]; artifacts: Record<string, string> }>;
}

export async function runMvpDemo(options: { outputRoot?: string; repoRoot?: string } = {}): Promise<MvpDemoResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const fixtureRepo = join(repoRoot, "fixtures/repos/sample-js");
  const outputRoot = resolve(repoRoot, options.outputRoot ?? defaultOutputRoot);
  const childRunRoot = join(outputRoot, "_runs");
  const before = await fixtureSnapshot(fixtureRepo);

  await rm(outputRoot, { recursive: true, force: true });
  await ensureDir(outputRoot);

  const childRuns = await runChildRuns(fixtureRepo, childRunRoot);
  await copyChildArtifacts(outputRoot, childRuns);

  const proposalPatchPath = join(outputRoot, "proposal/proposal.patch");
  await verifyPatchApplies(fixtureRepo, proposalPatchPath);
  const after = await fixtureSnapshot(fixtureRepo);
  const fixtureUnchanged = snapshotsEqual(before, after);
  if (!fixtureUnchanged) throw new Error("MVP demo fixture repo was modified.");

  const rootGitStatus = await gitStatus(repoRoot);
  await writeText(join(outputRoot, "task.md"), renderTask());
  await writeJson(join(outputRoot, "trajectory.json"), buildTrajectory(outputRoot, childRuns, fixtureUnchanged));
  await writeJson(join(outputRoot, "safety-report.json"), buildSafetyReport(childRuns.proposal, fixtureUnchanged));
  await writeJson(join(outputRoot, "child-runs.json"), childRunRecords(childRuns));
  await writeText(
    join(outputRoot, "human-review.md"),
    renderHumanReview({
      fixtureRepo,
      childRuns,
      fixtureUnchanged,
      rootGitStatus
    })
  );

  return {
    outputRoot,
    fixtureRepo,
    humanReviewPath: join(outputRoot, "human-review.md"),
    proposalPatchPath,
    patchCheck: { ok: true, command: "git apply --check proposal/proposal.patch" },
    fixtureUnchanged,
    rootGitStatus,
    childRuns: childRunRecords(childRuns)
  };
}

async function runChildRuns(fixtureRepo: string, outDir: string) {
  const context = await runRunForge({
    runId: "context-pack",
    taskType: "context-pack",
    repoPath: fixtureRepo,
    goal: "Collect the calculator implementation, failing expectation, and package scripts for a tiny sample-js fix.",
    outDir,
    safetyProfile: "safe-local",
    contextPack: {
      allowExternalRepo: false,
      include: ["src/**/*.ts", "tests/**/*.ts", "package.json"],
      exclude: [],
      maxBytesPerFile: 12_000,
      maxTotalFiles: 10,
      maxTotalBytes: 50_000
    }
  });
  const check = await runRunForge({
    runId: "command-check",
    taskType: "command-check",
    repoPath: fixtureRepo,
    command: deterministicFailureCommand,
    outDir,
    safetyProfile: "trusted-local"
  });
  const proposal = await runRunForge({
    runId: "code-proposal",
    taskType: "code-proposal",
    repoPath: fixtureRepo,
    goal: "Propose changing the calculator test expectation from 3 to 2 without applying the patch.",
    outDir,
    safetyProfile: "safe-local",
    applyMode: "patch-artifact"
  });
  return { context, check, proposal };
}

async function copyChildArtifacts(
  outputRoot: string,
  childRuns: Awaited<ReturnType<typeof runChildRuns>>
): Promise<void> {
  await copyArtifact(childRuns.context.artifacts.contextPack, join(outputRoot, "context/context-pack.json"));
  await copyArtifact(childRuns.context.artifacts.contextPackMarkdown, join(outputRoot, "context/context-pack.md"));
  await copyArtifact(childRuns.check.artifacts.commandResult, join(outputRoot, "checks/command-result.json"));
  await copyArtifact(childRuns.check.artifacts.commandOutput, join(outputRoot, "checks/command-output.txt"));
  await copyArtifact(childRuns.proposal.artifacts.proposalPatch, join(outputRoot, "proposal/proposal.patch"));
  await copyArtifact(childRuns.proposal.artifacts.patchSummary, join(outputRoot, "proposal/patch-summary.md"));
}

async function copyArtifact(source: string | undefined, target: string): Promise<void> {
  if (!source) throw new Error(`Missing child artifact for ${target}.`);
  await ensureDir(dirname(target));
  await copyFile(source, target);
}

async function verifyPatchApplies(fixtureRepo: string, patchPath: string): Promise<void> {
  await execFileAsync("git", ["apply", "--check", patchPath], { cwd: fixtureRepo });
}

async function fixtureSnapshot(fixtureRepo: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const file of fixtureFiles) {
    const content = await readFile(join(fixtureRepo, file), "utf8");
    snapshot[file] = createHash("sha256").update(content).digest("hex");
  }
  return snapshot;
}

function snapshotsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return fixtureFiles.every((file) => left[file] === right[file]);
}

async function gitStatus(repoRoot: string): Promise<string> {
  const result = await execFileAsync("git", ["status", "--short"], { cwd: repoRoot });
  return result.stdout.trim();
}

function buildTrajectory(
  outputRoot: string,
  childRuns: Awaited<ReturnType<typeof runChildRuns>>,
  fixtureUnchanged: boolean
) {
  return {
    demo: "sample-js-fix",
    mode: "local deterministic MVP",
    outputRoot,
    stages: [
      "Task",
      "ContextPack",
      "CommandCheckEvidence",
      "GatedCodeProposal",
      "PatchValidation",
      "HumanReviewPacket"
    ],
    childRuns: childRunRecords(childRuns),
    validation: {
      proposalPatchAcceptedByGitApplyCheck: true,
      fixtureRepoUnchanged: fixtureUnchanged,
      repoMutationAllowed: false
    }
  };
}

function buildSafetyReport(childProposal: RunRecord, fixtureUnchanged: boolean) {
  return {
    demo: "sample-js-fix",
    localOnly: true,
    providerCallsAllowed: false,
    repoMutationAllowed: false,
    autoPrAllowed: false,
    autoMergeAllowed: false,
    patchMode: "proposal-only",
    humanDecisionRequired: true,
    fixtureRepoUnchanged: fixtureUnchanged,
    proposalRunSafety: childProposal.safety
  };
}

function childRunRecords(childRuns: Awaited<ReturnType<typeof runChildRuns>>) {
  return [
    summarizeChildRun("context-pack", childRuns.context),
    summarizeChildRun("command-check", childRuns.check),
    summarizeChildRun("code-proposal", childRuns.proposal)
  ];
}

function summarizeChildRun(name: string, record: RunRecord) {
  return {
    name,
    runId: record.runId,
    taskType: record.taskType,
    status: record.status,
    summary: record.summary,
    artifacts: record.artifacts
  };
}

function renderTask(): string {
  return `# RunForge MVP Demo Task

Fix the tiny sample-js calculator expectation.

The fixture has an \`add(left, right)\` implementation that returns the arithmetic sum. Its test currently expects \`add(1, 1)\` to be \`3\`, so the proposed fix is to change that expectation to \`2\`.

RunForge must collect context, capture failure evidence, prepare a gated patch proposal, and leave the fixture repository unchanged.
`;
}

function renderHumanReview(input: {
  fixtureRepo: string;
  childRuns: Awaited<ReturnType<typeof runChildRuns>>;
  fixtureUnchanged: boolean;
  rootGitStatus: string;
}): string {
  return `# RunForge MVP Demo Human Review

## What task was attempted?

RunForge attempted a small local engineering task in \`fixtures/repos/sample-js\`: fix the calculator test expectation so \`add(1, 1)\` expects \`2\` instead of \`3\`.

## What context was collected?

The context-pack child run collected the relevant fixture files:

- \`src/calculator.ts\`
- \`tests/calculator.test.ts\`
- \`package.json\`

Review the copied context artifacts at:

- \`context/context-pack.json\`
- \`context/context-pack.md\`

## What checks/evidence were used?

The command-check child run executed a deterministic local failure check for the same expectation mismatch. It exited non-zero and captured the evidence in:

- \`checks/command-result.json\`
- \`checks/command-output.txt\`

The command output records: \`Expected add(1, 1) to be 3, received 2\`.

## What patch is proposed?

The code-proposal child run wrote a proposal-only unified diff at:

- \`proposal/proposal.patch\`
- \`proposal/patch-summary.md\`

The proposed patch changes only \`tests/calculator.test.ts\`, replacing \`toBe(3)\` with \`toBe(2)\`.

## Why is it safe?

- The demo is local-only and deterministic.
- No LLM/API calls are made.
- Repository writes are disabled by the RunForge safety policy.
- No auto-PR, auto-merge, or patch application is performed.
- The patch was validated with \`git apply --check\` against \`${input.fixtureRepo}\`.
- The fixture repo hash snapshot matched before and after the demo.

## Was the repo modified?

No. Fixture unchanged: \`${input.fixtureUnchanged}\`.

Root worktree status after demo:

\`\`\`text
${input.rootGitStatus || "(clean)"}
\`\`\`

## What should a human do next?

Read \`proposal/proposal.patch\`, decide whether the one-line test expectation change is correct, and apply it manually outside RunForge if approved.

## Child Runs

${childRunRecords(input.childRuns).map((run) => `- ${run.name}: ${run.status} (${run.runId})`).join("\n")}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMvpDemo();
  console.log(`RunForge MVP demo written to ${result.outputRoot}`);
  console.log(`Human review: ${result.humanReviewPath}`);
  console.log(`Proposal patch: ${result.proposalPatchPath}`);
  console.log(`Patch check: ${result.patchCheck.ok ? "passed" : "failed"}`);
  console.log(`Fixture unchanged: ${result.fixtureUnchanged ? "yes" : "no"}`);
}
