import { Command, InvalidArgumentError } from "commander";
import type { RunSpec, TaskType } from "../../core/types.js";
import { loadRunSpecFile } from "../../run/runspec-loader.js";
import { runRunForge } from "../../run/run-runner.js";
import { runSpecTaskTypes } from "../../run/runspec-schema.js";

const taskTypes: TaskType[] = runSpecTaskTypes;

export function runCommand(): Command {
  return new Command("run")
    .description("Run a local Agentic Engineering Harness task through unified rails.")
    .option("--spec <path>", "RunSpec JSON file")
    .option("--task <type>", "task type", parseTaskType)
    .option("--repo <path>", "repository/workspace path")
    .option("--out <path>", "artifact output root")
    .option("--goal <text>", "task goal")
    .option("--log <path>", "failure log or context log path")
    .option("--command <command>", "command to run for command-check")
    .option("--safety-profile <profile>", "safe-local or trusted-local", "safe-local")
    .option("--apply-mode <mode>", "none, patch-artifact, or isolated-worktree")
    .action(async (opts) => {
      const spec = opts.spec ? await loadRunSpecFile(opts.spec) : buildCliRunSpec(opts);
      const record = await runRunForge(spec);
      console.log(renderRunSummary(record));
      console.log(`Run record: ${record.artifacts.runRecord}`);
    });
}

function renderRunSummary(record: Awaited<ReturnType<typeof runRunForge>>): string {
  if (record.summary.startsWith("proposal_ready:")) {
    return `RunForge proposal ready: Human decision required. Repo not modified. ${record.summary.replace(/^proposal_ready:\s*/, "")}`;
  }
  return `RunForge ${record.status}: ${record.summary}`;
}

function buildCliRunSpec(opts: {
  task?: TaskType;
  repo?: string;
  out?: string;
  goal?: string;
  log?: string;
  command?: string;
  safetyProfile: string;
  applyMode?: string;
}): RunSpec {
  if (!opts.task) throw new InvalidArgumentError("--task is required unless --spec is provided.");
  if (!opts.repo) throw new InvalidArgumentError("--repo is required unless --spec is provided.");
  if (!opts.out) throw new InvalidArgumentError("--out is required unless --spec is provided.");
  return {
    taskType: opts.task,
    repoPath: opts.repo,
    goal: opts.goal,
    logPath: opts.log,
    command: opts.command,
    outDir: opts.out,
    safetyProfile: parseSafetyProfile(opts.safetyProfile),
    applyMode: opts.applyMode ? parseApplyMode(opts.applyMode) : undefined
  };
}

function parseTaskType(value: string): TaskType {
  if (taskTypes.includes(value as TaskType)) return value as TaskType;
  throw new InvalidArgumentError(`Expected one of: ${taskTypes.join(", ")}`);
}

function parseSafetyProfile(value: string): RunSpec["safetyProfile"] {
  if (value === "safe-local" || value === "trusted-local") return value;
  throw new InvalidArgumentError("Expected safe-local or trusted-local.");
}

function parseApplyMode(value: string): RunSpec["applyMode"] {
  if (value === "none" || value === "patch-artifact" || value === "isolated-worktree") return value;
  throw new InvalidArgumentError("Expected none, patch-artifact, or isolated-worktree.");
}
