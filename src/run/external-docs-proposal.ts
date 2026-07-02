import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunRecord, RunSpec } from "../core/types.js";
import { getRunForgeVersionInfo, type RunForgeVersionInfo } from "../core/version.js";
import { resolveExternalDocsTextInputs, type ResolvedExternalDocsTextInputs } from "./external-docs-cli-inputs.js";
import { runRunForge } from "./run-runner.js";
import { normalizeRunSpecDocument, type RunSpecDocument } from "./runspec-schema.js";

const defaultExcludes = ["node_modules/**", "dist/**", "build/**", "coverage/**", ".git/**", "artifacts/**", "output/**", "tmp/**", "reports/**"];

export interface ExternalDocsProposalOptions {
  repo: string;
  target: string;
  evidence: string[];
  anchor?: string;
  anchorFile?: string;
  insert?: string;
  insertFile?: string;
  rationale?: string;
  rationaleFile?: string;
  out?: string;
  runId?: string;
  artifactNamespace?: string;
  exclude?: string[];
  maxBytesPerFile?: number;
}

export async function runExternalDocsProposalPacket(options: ExternalDocsProposalOptions): Promise<{
  packetDir: string;
  proposalRecord: RunRecord;
  applyCheck: string;
  proposalOutcome: string;
  versionInfo: RunForgeVersionInfo;
}> {
  const spec = await buildExternalDocsProposalSpec(options);
  const packetDir = join(resolve(options.out ?? defaultOutDir()), "packet");
  await mkdir(packetDir, { recursive: true });
  const proposalRecord = await runRunForge(spec);
  const patch = await readFile(proposalRecord.artifacts.proposalPatch, "utf8");
  const proposalStatus = await readFile(proposalRecord.artifacts.proposalStatus, "utf8");
  const proposalOutcome = parseProposalOutcome(proposalStatus, proposalRecord);
  const applyCheck = patch.length === 0
    ? "not run: proposal.patch is empty because no proposal was generated"
    : safeGitApplyCheck(spec.repoPath, proposalRecord.artifacts.proposalPatch);

  await copyOptionalArtifact(proposalRecord.artifacts.contextPack, join(packetDir, "context-pack.json"));
  await copyOptionalArtifact(proposalRecord.artifacts.contextPackMarkdown, join(packetDir, "context-pack.md"));
  await copyFile(proposalRecord.artifacts.proposalPatch, join(packetDir, "proposal.patch"));
  await copyFile(proposalRecord.artifacts.patchSummary, join(packetDir, "patch-summary.md"));
  await copyFile(proposalRecord.artifacts.safetyReport, join(packetDir, "safety-report.json"));
  await copyFile(proposalRecord.artifacts.trajectory, join(packetDir, "trajectory.json"));
  await copyFile(proposalRecord.artifacts.runSpec, join(packetDir, "run-spec.json"));
  await copyFile(proposalRecord.artifacts.proposalStatus, join(packetDir, "proposal-status.json"));
  await writeFile(join(packetDir, "human-review.md"), renderExternalHumanReview({
    repoPath: spec.repoPath,
    targetFile: spec.docsProposal?.targetFile ?? options.target,
    evidenceFiles: spec.docsProposal?.evidenceFiles ?? options.evidence,
    proposalRecord,
    applyCheck,
    patchBytes: Buffer.byteLength(patch, "utf8"),
    proposalStatus
  }), "utf8");

  return {
    packetDir,
    proposalRecord,
    applyCheck,
    proposalOutcome,
    versionInfo: getRunForgeVersionInfo()
  };
}

export async function buildExternalDocsProposalSpec(options: ExternalDocsProposalOptions): Promise<RunSpec> {
  const resolved = await resolveTextOptions(options);
  validateResolvedCliOptions(options, resolved);
  const repoPath = resolve(options.repo);
  await assertDirectory(repoPath, "--repo");
  await assertFile(repoPath, options.target, "--target");
  for (const file of options.evidence) await assertFile(repoPath, file, "--evidence");
  const targetText = await readFile(join(repoPath, options.target), "utf8");
  if (!targetText.includes(resolved.anchor)) throw new Error(`--anchor text was not found in ${options.target}.`);

  const include = [...new Set([options.target, ...options.evidence])];
  const document: RunSpecDocument = {
    schemaVersion: 1,
    taskType: "code-proposal",
    runId: options.runId ?? "external-docs-proposal",
    artifactNamespace: options.artifactNamespace ?? "external-docs",
    outDir: join(resolve(options.out ?? defaultOutDir()), "proposal"),
    input: {
      repoPath,
      allowExternalRepo: true,
      include,
      exclude: options.exclude ?? defaultExcludes,
      docsProposal: {
        targetFile: options.target,
        anchorText: resolved.anchor,
        insertedText: resolved.insert,
        rationale: resolved.rationale,
        evidenceFiles: options.evidence,
        maxBytesPerFile: options.maxBytesPerFile
      }
    },
    safety: {
      repoWritesAllowed: false,
      networkAllowed: false,
      applyMode: "patch-artifact"
    }
  };
  return normalizeRunSpecDocument(document, process.cwd());
}

export function renderExternalDocsProposalSummary(result: {
  packetDir: string;
  proposalRecord: RunRecord;
  applyCheck: string;
  proposalOutcome: string;
  versionInfo: RunForgeVersionInfo;
}): string {
  const status = result.proposalRecord.artifacts;
  const humanDecisionRequired =
    ((result.proposalRecord.safety as { humanDecisionRequired?: boolean }).humanDecisionRequired ?? true) ? "yes" : "no";
  const lines = [
    "RunForge external docs proposal packet ready.",
    `RunForge version: ${result.versionInfo.version}`,
    `RunForge git SHA: ${result.versionInfo.gitSha}`,
    `Packet directory: ${result.packetDir}`,
    `Proposal outcome: ${result.proposalOutcome}`,
    `human-review.md: ${join(result.packetDir, "human-review.md")}`,
    `proposal-status.json: ${join(result.packetDir, "proposal-status.json")}`,
    `proposal.patch: ${join(result.packetDir, "proposal.patch")}`,
    `patch-summary.md: ${join(result.packetDir, "patch-summary.md")}`,
    `context-pack.md: ${join(result.packetDir, "context-pack.md")}`,
    `Human decision required: ${humanDecisionRequired}`,
    `Suggested check: ${result.applyCheck}`,
    "Reminder: proposal.patch was not applied; no target repo writes, push, or merge were performed.",
    `Source run record: ${status.runRecord}`
  ];
  if ((result.versionInfo.behindBy ?? 0) > 0) {
    lines.splice(3, 0, `Warning: this checkout is behind ${result.versionInfo.upstream ?? "upstream"} by ${result.versionInfo.behindBy} commit(s). Run git fetch origin && git pull --ff-only before external trials.`);
  }
  return lines.join("\n");
}

async function resolveTextOptions(options: ExternalDocsProposalOptions): Promise<ResolvedExternalDocsTextInputs> {
  return resolveExternalDocsTextInputs(options);
}

function validateResolvedCliOptions(options: ExternalDocsProposalOptions, resolved: ResolvedExternalDocsTextInputs): void {
  if (!options.repo) throw new Error("--repo is required.");
  if (!options.target) throw new Error("--target is required.");
  if (!resolved.anchor) throw new Error("--anchor is required.");
  if (!resolved.insert) throw new Error("--insert is required.");
  if (!options.evidence || options.evidence.length === 0) throw new Error("At least one --evidence file is required.");
  for (const [field, value] of [["--target", options.target], ...options.evidence.map((file) => ["--evidence", file] as const)] as const) {
    assertSafeRepoRelativePath(value, field);
  }
}

function parseProposalOutcome(proposalStatus: string, record: RunRecord): string {
  try {
    const parsed = JSON.parse(proposalStatus) as { outcome?: string };
    return parsed.outcome ?? record.status;
  } catch {
    return record.summary.includes(":") ? record.summary.split(":")[0] : record.status;
  }
}

function assertSafeRepoRelativePath(path: string, field: string): void {
  if (path.length === 0) throw new Error(`${field} must be a non-empty relative path.`);
  if (isAbsolute(path)) throw new Error(`${field} must be relative to --repo.`);
  const rel = relative(".", path);
  if (rel.startsWith("..") || isAbsolute(rel) || path.includes("\\")) {
    throw new Error(`${field} must stay inside --repo and cannot use path traversal.`);
  }
}

async function assertDirectory(path: string, field: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${field} path is not a directory: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a directory")) throw error;
    throw new Error(`${field} path does not exist: ${path}`);
  }
}

async function assertFile(repoPath: string, path: string, field: string): Promise<void> {
  const fullPath = resolve(repoPath, path);
  const rel = relative(repoPath, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${field} must stay inside --repo.`);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) throw new Error(`${field} file is not a file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a file")) throw error;
    throw new Error(`${field} file does not exist: ${path}`);
  }
}

function safeGitApplyCheck(repoPath: string, patchPath: string): string {
  const result = spawnSync("git", ["apply", "--check", patchPath], { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return `failed: ${result.stdout}${result.stderr}`.trim();
  return `git apply --check ${patchPath}`;
}

async function copyOptionalArtifact(source: string | undefined, target: string): Promise<void> {
  if (!source) return;
  await copyFile(source, target);
}

function renderExternalHumanReview(input: {
  repoPath: string;
  targetFile: string;
  evidenceFiles: string[];
  proposalRecord: RunRecord;
  applyCheck: string;
  patchBytes: number;
  proposalStatus: string;
}): string {
  return `# External Docs Proposal Review

## Target Repository

${input.repoPath}

## Target File

${input.targetFile}

## Scoped Evidence

${input.evidenceFiles.map((file) => `- ${file}`).join("\n")}

## Proposal Outcome

\`\`\`json
${input.proposalStatus.trim()}
\`\`\`

The source run may still show internal status \`blocked\` because repository
mutation is blocked by design. Use the proposal outcome above for the packet
decision.

## Patch

Inspect \`proposal.patch\`. Patch bytes: ${input.patchBytes}.

## Safety

- Proposal-only packet.
- Target repository modified: no.
- Patch applied by RunForge: no.
- Push or merge performed by RunForge: no.
- LLM/API calls performed by this flow: no.
- Apply check: \`${input.applyCheck}\`.

## Human Next Step

Review \`patch-summary.md\` and \`proposal.patch\`. Apply any acceptable patch manually outside RunForge.

## Source Run

- ${input.proposalRecord.artifacts.run}
`;
}

function defaultOutDir(): string {
  return "artifacts/runs/external-docs-proposal-cli";
}
