import { exec } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readText, writeJson, writeText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { scanSecrets } from "../security/secret-scan.js";
import { runTriage } from "../triage/triage-runner.js";
import { inspectRepo } from "../triage/repo-inspector.js";
import { buildFixtureCodeProposal, type DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { validateCommandSafety } from "./command-safety.js";
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
      return contextPack(input.spec, input.runDir);
    case "code-proposal":
      return codeProposal(input.spec, input.runDir);
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

async function contextPack(spec: RunSpec, runDir: string): Promise<TaskResult> {
  const logText = spec.logPath ? await readText(spec.logPath) : "";
  const repo = await inspectRepo(spec.repoPath, `${spec.goal ?? ""}\n${logText}`);
  const contextPath = join(runDir, "context-pack.json");
  await writeJson(contextPath, { goal: spec.goal, logPath: spec.logPath, repo });
  return { status: "passed", artifacts: { contextPack: contextPath }, summary: "Context pack generated from repo metadata and optional log input." };
}

async function codeProposal(spec: RunSpec, runDir: string): Promise<TaskResult> {
  const summaryPath = join(runDir, "patch-summary.md");
  const patchPath = join(runDir, "proposal.patch");
  const files = await listRepoFiles(spec.repoPath);
  const proposal = await buildFixtureCodeProposal(spec);
  await writeText(summaryPath, renderProposal(spec, files, proposal));
  await writeText(patchPath, proposal?.patch ?? "");
  return {
    status: "blocked",
    artifacts: { patchSummary: summaryPath, proposalPatch: patchPath },
    summary: "Code proposal prepared as gated artifacts only; human review is required before any write."
  };
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

function renderProposal(spec: RunSpec, files: string[], proposal: DeterministicCodeProposal | null): string {
  const filesChanged = proposal?.filesChanged.map((file) => `- ${file}`).join("\n") ?? "- No files proposed for change.";
  const why = proposal?.rationale ?? "No deterministic fixture rule matched this repository and goal.";
  const proposedPatch =
    proposal === null
      ? "No deterministic patch was generated by this minimal local rails implementation. The patch artifact is intentionally empty."
      : "A deterministic fixture patch was written to proposal.patch for human review.";

  return `# Code Proposal

## Task Summary

${proposal?.taskSummary ?? spec.goal ?? "No goal provided."}

## Files Proposed To Change

${filesChanged}

## Why This Patch Is Suggested

${why}

## Safety Status

- Proposal-first only.
- No direct writes to the target repository.
- Repository was not modified by RunForge.
- Artifact-only output: inspect proposal.patch and patch-summary.md.
- No auto-push.
- No auto-merge.
- Human decision required before applying any patch.

## Repo Snapshot

${files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- No files listed."}

## Proposed Patch

${proposedPatch}

## Manual Next Step

A human can inspect proposal.patch and, if acceptable, apply it manually outside RunForge.
`;
}
