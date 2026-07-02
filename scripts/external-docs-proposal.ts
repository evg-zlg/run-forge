import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRecord, RunSpec } from "../src/core/types.js";
import { runRunForge } from "../src/run/run-runner.js";

const defaultExternalRepo = "/Users/evgeny/Documents/projects/smartsql";
const defaultOutDir = "artifacts/runs/external-docs-proposal";

export async function runExternalDocsProposal(input: {
  externalRepo?: string;
  outDir?: string;
} = {}): Promise<{ packetDir: string; proposalRecord?: RunRecord; applyCheck: string }> {
  const externalRepo = resolve(input.externalRepo ?? process.env.RUNFORGE_EXTERNAL_REPO ?? defaultExternalRepo);
  const outRoot = resolve(input.outDir ?? process.env.RUNFORGE_EXTERNAL_OUT ?? defaultOutDir);
  const packetDir = join(outRoot, "packet");
  const spec = proposalSpec(externalRepo, join(outRoot, "proposal"));
  await rm(packetDir, { recursive: true, force: true });
  await mkdir(packetDir, { recursive: true });

  let finalizingInterrupt = false;
  const interruptHandler = () => {
    if (finalizingInterrupt) return;
    finalizingInterrupt = true;
    void writeFallbackPacket({
      packetDir,
      externalRepo,
      spec,
      outcome: "interrupted",
      message: "Run interrupted by SIGINT before the external docs proposal packet completed."
    }).finally(() => process.exit(130));
  };
  process.once("SIGINT", interruptHandler);

  try {
    await assertDirectory(externalRepo);
    const proposalRecord = await runRunForge(spec);
    const patch = await readFile(proposalRecord.artifacts.proposalPatch, "utf8");
    const proposalStatus = await readFile(proposalRecord.artifacts.proposalStatus, "utf8");
    const applyCheck = patch.length === 0
      ? "not run: proposal.patch is empty because no proposal was generated"
      : safeGitApplyCheck(externalRepo, proposalRecord.artifacts.proposalPatch);

    await copyOptionalArtifact(proposalRecord.artifacts.contextPack, join(packetDir, "context-pack.json"));
    await copyOptionalArtifact(proposalRecord.artifacts.contextPackMarkdown, join(packetDir, "context-pack.md"));
    await copyFile(proposalRecord.artifacts.proposalPatch, join(packetDir, "proposal.patch"));
    await copyFile(proposalRecord.artifacts.patchSummary, join(packetDir, "patch-summary.md"));
    await copyFile(proposalRecord.artifacts.safetyReport, join(packetDir, "safety-report.json"));
    await copyFile(proposalRecord.artifacts.trajectory, join(packetDir, "trajectory.json"));
    await copyFile(proposalRecord.artifacts.runSpec, join(packetDir, "run-spec.json"));
    await copyFile(proposalRecord.artifacts.proposalStatus, join(packetDir, "proposal-status.json"));
    await writeFile(join(packetDir, "human-review.md"), renderHumanReview({
      externalRepo,
      proposalRecord,
      applyCheck,
      patchBytes: Buffer.byteLength(patch, "utf8"),
      proposalStatus
    }), "utf8");

    console.log(`[external-docs-proposal] packet: ${packetDir}`);
    return { packetDir, proposalRecord, applyCheck };
  } catch (error) {
    await writeFallbackPacket({
      packetDir,
      externalRepo,
      spec,
      outcome: isInvalidSpecError(error) ? "invalid_spec" : "proposal_failed",
      message: error instanceof Error ? error.message : String(error)
    });
    console.log(`[external-docs-proposal] packet: ${packetDir}`);
    throw error;
  } finally {
    process.removeListener("SIGINT", interruptHandler);
  }
}

function proposalSpec(repoPath: string, outDir: string): RunSpec {
  return {
    runId: "external-docs-proposal",
    artifactNamespace: "external-dogfood",
    taskType: "code-proposal",
    repoPath,
    allowExternalRepo: true,
    goal: "Mention existing root `npm run dev:stable` in README quick start.",
    docsProposal: {
      allowExternalRepo: true,
      include: ["README.md", "package.json", "docs/BUILD_STABILITY.md"],
      exclude: ["node_modules/**", "dist/**", ".git/**", "output/**", "tmp/**", "reports/**"],
      targetFile: "README.md",
      anchorText: "npm run dev\n```",
      insertedText: "\n\nFor the stable frontend dev path, use the existing root command:\n\n```bash\nnpm run dev:stable\n```",
      rationale: "`package.json` exposes a root `dev:stable` script, and docs/BUILD_STABILITY.md documents it as the stable local development path.",
      evidenceFiles: ["README.md", "package.json", "docs/BUILD_STABILITY.md"]
    },
    outDir,
    safetyProfile: "safe-local",
    applyMode: "patch-artifact"
  };
}

function runGitApplyCheck(repoPath: string, patchPath: string): string {
  const result = spawnSync("git", ["apply", "--check", patchPath], { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`git apply --check failed for ${patchPath}\n${result.stdout}${result.stderr}`);
  }
  return `git apply --check ${patchPath}`;
}

function safeGitApplyCheck(repoPath: string, patchPath: string): string {
  try {
    return runGitApplyCheck(repoPath, patchPath);
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory.`);
}

function isInvalidSpecError(error: unknown): boolean {
  return error instanceof Error && /not a directory|ENOENT|no such file/i.test(error.message);
}

async function copyOptionalArtifact(source: string | undefined, target: string): Promise<void> {
  if (!source) return;
  await copyFile(source, target);
}

async function writeFallbackPacket(input: {
  packetDir: string;
  externalRepo: string;
  spec: RunSpec;
  outcome: "proposal_failed" | "interrupted" | "timeout" | "invalid_spec";
  message: string;
}): Promise<void> {
  await writeFile(join(input.packetDir, "run-spec.json"), `${JSON.stringify(input.spec, null, 2)}\n`, "utf8");
  await writeFile(join(input.packetDir, "safety-report.json"), `${JSON.stringify({
    outcome: input.outcome,
    repoWritesAllowed: false,
    humanDecisionRequired: true,
    diagnostics: [input.message]
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.packetDir, "proposal-status.json"), `${JSON.stringify({
    outcome: input.outcome,
    filesChanged: [],
    evidenceFiles: [],
    diagnostics: [input.message],
    patchBytes: 0
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.packetDir, "proposal.patch"), "", "utf8");
  await writeFile(join(input.packetDir, "patch-summary.md"), `# Code Proposal

## Outcome

${input.outcome}

## Diagnostics

- ${input.message}

## Safety Status

- Proposal-first only.
- No direct writes to the target repository.
- Repository was not modified by RunForge.
- Human decision required before applying any patch.
`, "utf8");
  await writeFile(join(input.packetDir, "trajectory.json"), `${JSON.stringify({
    mode: "local",
    command: "external-docs-proposal",
    result: {
      outcome: input.outcome,
      summary: input.message
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.packetDir, "human-review.md"), `# External Docs Proposal Review

## What external repo was tested?

${input.externalRepo}

## What task was attempted?

Mention existing root \`npm run dev:stable\` in README quick start.

## What step failed?

${input.outcome}: ${input.message}

## What artifacts were produced?

This failure packet contains \`run-spec.json\`, \`safety-report.json\`,
\`proposal-status.json\`, \`proposal.patch\`, \`patch-summary.md\`,
\`trajectory.json\`, and \`human-review.md\`.

## Was the external repo modified?

No. RunForge generated artifacts only.

## What should a human do next?

Inspect \`proposal-status.json\` and fix the failing setup or spec before
requesting another proposal packet.
`, "utf8");
}

function renderHumanReview(input: {
  externalRepo: string;
  proposalRecord: RunRecord;
  applyCheck: string;
  patchBytes: number;
  proposalStatus: string;
}): string {
  return `# External Docs Proposal Review

## What external repo was tested?

${input.externalRepo}

## What task was attempted?

Mention existing root \`npm run dev:stable\` in README quick start.

## What files were requested as scoped evidence?

- README.md
- package.json
- docs/BUILD_STABILITY.md

## What evidence supported the proposal?

Inspect \`context-pack.md\`, \`context-pack.json\`, and \`proposal-status.json\`.
If evidence was missing or excluded, this packet is marked no-proposal and
\`proposal.patch\` is intentionally empty.

## What was the packet outcome?

\`\`\`json
${input.proposalStatus.trim()}
\`\`\`

## What patch was proposed?

Inspect \`proposal.patch\`. Patch bytes: ${input.patchBytes}.

## Was the external repo modified?

No. RunForge generated artifacts only. Apply check: \`${input.applyCheck}\`.

## What should a human do next?

Review \`patch-summary.md\` first. If \`proposal-status.json\` says
\`proposal_ready\` and the patch is acceptable, apply it manually in the
external repository. If it says \`evidence_missing\` or
\`no_proposal_generated\`, fix the spec/evidence before requesting a patch.

## Source Runs

- Proposal run: ${input.proposalRecord.artifacts.run}
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExternalDocsProposal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
