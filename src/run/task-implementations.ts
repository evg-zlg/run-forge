import { exec } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeJson, writeText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { scanSecrets } from "../security/secret-scan.js";
import { runTriage } from "../triage/triage-runner.js";
import { inspectRepo } from "../triage/repo-inspector.js";
import { buildFixtureCodeProposal } from "./code-proposal-fixtures.js";
import { renderProposal } from "./code-proposal-renderer.js";
import { blockedByCodeProposalScope, collectCodeProposalFiles } from "./code-proposal-scope.js";
import { validateCommandSafety } from "./command-safety.js";
import { buildContextPack } from "./context-pack.js";
import type { RunSafetyPolicy } from "./safety-policy.js";

const execAsync = promisify(exec);

export interface TaskResult {
  status: "passed" | "failed" | "blocked";
  artifacts: Record<string, string>;
  summary: string;
}

interface CommandResult {
  command: string;
  blocked: boolean;
  blockReason: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  errorSummary: string | null;
  executed: boolean;
}

type CommandResultInput = Omit<CommandResult, "blockReason" | "exitCode" | "signal" | "errorSummary"> &
  Partial<Pick<CommandResult, "blockReason" | "exitCode" | "signal" | "errorSummary">>;

export async function executeTask(input: {
  spec: RunSpec;
  runDir: string;
  safety: RunSafetyPolicy;
}): Promise<TaskResult> {
  if (input.safety.blockedReasons.length > 0) {
    if (input.spec.taskType === "command-check") return commandCheck(input.spec, input.runDir, input.safety);
    return blocked(input.runDir, input.safety.blockedReasons);
  }
  switch (input.spec.taskType) {
    case "failure-triage":
      return failureTriage(input.spec, input.runDir);
    case "command-check":
      return commandCheck(input.spec, input.runDir, input.safety);
    case "repo-research":
      return repoResearch(input.spec, input.runDir);
    case "context-pack":
      return contextPack(input.spec, input.runDir, input.safety);
    case "code-proposal":
      return codeProposal(input.spec, input.runDir, input.safety);
  }
}

async function failureTriage(spec: RunSpec, runDir: string): Promise<TaskResult> {
  if (!spec.logPath) return blocked(runDir, ["failure-triage requires logPath."]);
  const taskDir = join(runDir, "failure-triage");
  await runTriage({ repoPath: spec.repoPath, logPath: spec.logPath, outPath: taskDir, provider: "mock" });
  return {
    status: "passed",
    artifacts: taskArtifacts(taskDir, ["review.md", "trajectory.json", "safety-report.json", "context-summary.json"]),
    summary: "Failure triage completed using the local deterministic provider."
  };
}

async function commandCheck(spec: RunSpec, runDir: string, safety: RunSafetyPolicy): Promise<TaskResult> {
  if (!spec.command) return blocked(runDir, ["command-check requires command."]);
  if (safety.blockedReasons.length > 0) return writeCommandResult(runDir, {
    command: spec.command,
    blocked: true,
    blockReason: safety.blockedReasons.join(" "),
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    errorSummary: null,
    executed: false
  });
  const commandBlock = validateCommandSafety(spec.command);
  if (commandBlock) return writeCommandResult(runDir, {
    command: spec.command,
    blocked: true,
    blockReason: commandBlock.reason,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    errorSummary: null,
    executed: false
  });
  if (!safety.commandExecutionAllowed) return writeCommandResult(runDir, {
    command: spec.command,
    blocked: true,
    blockReason: "Command execution is not allowed by safety policy.",
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    errorSummary: null,
    executed: false
  });
  try {
    const result = await execAsync(spec.command, { cwd: spec.repoPath, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const output = `$ ${spec.command}\n\n${result.stdout}${result.stderr}`;
    const outputScan = scanSecrets(output);
    if (outputScan.status === "failed") return writeCommandResult(runDir, {
      command: spec.command,
      blocked: true,
      blockReason: "Secret-like values were detected in command output.",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      errorSummary: null,
      executed: false
    });
    return writeCommandResult(runDir, {
      command: spec.command,
      blocked: false,
      blockReason: null,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      signal: null,
      errorSummary: null,
      executed: true
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number | string; signal?: string };
    const output = `$ ${spec.command}\n\n${failure.stdout ?? ""}${failure.stderr ?? ""}\n${failure.message ?? ""}`;
    const outputScan = scanSecrets(output);
    if (outputScan.status === "failed") return writeCommandResult(runDir, {
      command: spec.command,
      blocked: true,
      blockReason: "Secret-like values were detected in command output.",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      errorSummary: null,
      executed: false
    });
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    return writeCommandResult(runDir, {
      command: spec.command,
      blocked: false,
      blockReason: null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode,
      signal: failure.signal ?? null,
      errorSummary: failure.message ?? "Command execution failed.",
      executed: true
    });
  }
}

async function repoResearch(spec: RunSpec, runDir: string): Promise<TaskResult> {
  const researchPath = join(runDir, "repo-research.json");
  const repo = await inspectRepo(spec.repoPath, spec.goal ?? "");
  await writeJson(researchPath, { goal: spec.goal, repo });
  return { status: "passed", artifacts: { repoResearch: researchPath }, summary: "Repository metadata and guidance files inspected." };
}

async function contextPack(spec: RunSpec, runDir: string, safety: RunSafetyPolicy): Promise<TaskResult> {
  const result = await buildContextPack({ spec, runDir, safety });
  return { status: result.selectedNoFiles ? "blocked" : "passed", artifacts: result.artifacts, summary: result.summary };
}

async function codeProposal(spec: RunSpec, runDir: string, safety: RunSafetyPolicy): Promise<TaskResult> {
  const summaryPath = join(runDir, "patch-summary.md");
  const patchPath = join(runDir, "proposal.patch");
  const proposalStatusPath = join(runDir, "proposal-status.json");
  const contextResult = spec.docsProposal ? await buildDocsProposalContextPack(spec, runDir, safety) : null;
  const files = spec.docsProposal ? await collectCodeProposalFiles(spec) : await listRepoFiles(spec.repoPath);
  const proposal = blockedByCodeProposalScope(spec, files) ?? await buildFixtureCodeProposal(spec, files);
  await writeText(summaryPath, renderProposal(spec, files, proposal));
  await writeText(patchPath, proposal?.patch ?? "");
  await writeJson(proposalStatusPath, {
    outcome: proposal?.outcome ?? "no_proposal_generated",
    filesChanged: proposal?.filesChanged ?? [],
    evidenceFiles: proposal?.evidenceFiles ?? [],
    diagnostics: proposal?.diagnostics ?? [],
    patchBytes: proposal?.patch.length ?? 0
  });
  const artifacts = {
    ...(contextResult?.artifacts ?? {}),
    patchSummary: summaryPath,
    proposalPatch: patchPath,
    proposalStatus: proposalStatusPath
  };
  if (proposal?.patch === "") {
    return {
      status: "blocked",
      artifacts,
      summary: `${proposal.outcome ?? "no_proposal_generated"}: ${proposal.rationale} No patch was written; inspect patch-summary.md before changing the target repo.`
    };
  }
  return {
    status: "blocked",
    artifacts,
    summary: "proposal_ready: Code proposal prepared as gated artifacts only; human review is required before any write."
  };
}

async function buildDocsProposalContextPack(
  spec: RunSpec,
  runDir: string,
  safety: RunSafetyPolicy
): Promise<{ artifacts: Record<string, string> }> {
  if (!spec.docsProposal) return { artifacts: {} };
  const include = spec.docsProposal.include ?? [...new Set([spec.docsProposal.targetFile, ...spec.docsProposal.evidenceFiles])];
  return buildContextPack({
    spec: {
      ...spec,
      taskType: "context-pack",
      contextPack: {
        allowExternalRepo: spec.docsProposal.allowExternalRepo,
        include,
        exclude: spec.docsProposal.exclude ?? [],
        maxBytesPerFile: 12_000,
        maxTotalFiles: 80,
        maxTotalBytes: 240_000
      }
    },
    runDir,
    safety
  });
}

async function writeCommandResult(runDir: string, input: CommandResultInput): Promise<TaskResult> {
  const result = normalizeCommandResult(input);
  const resultPath = join(runDir, "command-result.json");
  const outputPath = join(runDir, "command-output.txt");
  await writeJson(resultPath, result);
  await writeText(outputPath, renderCommandOutput(result));
  if (result.blocked) {
    return {
      status: "blocked",
      artifacts: { commandResult: resultPath, commandOutput: outputPath },
      summary: result.blockReason ?? "Command was blocked."
    };
  }
  return {
    status: result.exitCode === 0 ? "passed" : "failed",
    artifacts: { commandResult: resultPath, commandOutput: outputPath },
    summary: result.exitCode === 0 ? "Command completed successfully." : "Command exited with a failure."
  };
}

function normalizeCommandResult(result: CommandResultInput): CommandResult {
  return {
    command: result.command,
    blocked: result.blocked,
    blockReason: result.blockReason ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    errorSummary: result.errorSummary ?? null,
    executed: result.executed
  };
}

function renderCommandOutput(result: CommandResult): string {
  return [
    `$ ${result.command}`,
    "",
    result.blocked ? `Blocked: ${result.blockReason ?? "yes"}` : `Exit code: ${result.exitCode ?? "unknown"}`,
    result.signal ? `Signal: ${result.signal}` : "",
    result.errorSummary ? `Error: ${result.errorSummary}` : "",
    "",
    result.stdout,
    result.stderr
  ].filter((line) => line.length > 0).join("\n");
}

async function blocked(runDir: string, reasons: string[]): Promise<TaskResult> {
  const path = join(runDir, "blocked.json");
  await writeJson(path, { reasons });
  return { status: "blocked", artifacts: { blocked: path }, summary: reasons.join(" ") };
}

function taskArtifacts(dir: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name.replace(/\W+/g, "_").replace(/_$/, ""), join(dir, name)]));
}

async function listRepoFiles(repoPath: string): Promise<string[]> {
  const found: string[] = [];
  await walk(repoPath, "", found);
  return found.slice(0, 80);
}

async function walk(root: string, relative: string, found: string[]): Promise<void> {
  if (found.length >= 80 || skip(relative)) return;
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (skip(child)) continue;
    if (entry.isDirectory()) await walk(root, child, found);
    else if (entry.isFile() && (await stat(join(root, child))).size < 200_000) found.push(child);
    if (found.length >= 80) return;
  }
}

function skip(path: string): boolean {
  return /(^|\/)(\.git|node_modules|dist|build|coverage|artifacts)(\/|$)/.test(path);
}
