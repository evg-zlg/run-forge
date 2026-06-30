import { Command, InvalidArgumentError } from "commander";
import type { RunSpec, TaskType } from "../../core/types.js";
import { runRunForge } from "../../run/run-runner.js";

const taskTypes: TaskType[] = ["failure-triage", "command-check", "repo-research", "context-pack", "code-proposal"];

export function runCommand(): Command {
  return new Command("run")
    .description("Run a local Agentic Engineering Harness task through unified rails.")
    .requiredOption("--task <type>", "task type", parseTaskType)
    .requiredOption("--repo <path>", "repository/workspace path")
    .requiredOption("--out <path>", "artifact output root")
    .option("--goal <text>", "task goal")
    .option("--log <path>", "failure log or context log path")
    .option("--command <command>", "command to run for command-check")
    .option("--safety-profile <profile>", "safe-local or trusted-local", "safe-local")
    .option("--apply-mode <mode>", "none, patch-artifact, or isolated-worktree")
    .action(async (opts) => {
      const record = await runRunForge({
        taskType: opts.task,
        repoPath: opts.repo,
        goal: opts.goal,
        logPath: opts.log,
        command: opts.command,
        outDir: opts.out,
        safetyProfile: parseSafetyProfile(opts.safetyProfile),
        applyMode: opts.applyMode ? parseApplyMode(opts.applyMode) : undefined
      });
      console.log(`RunForge ${record.status}: ${record.summary}`);
      console.log(`Run record: ${record.artifacts.runRecord}`);
    });
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
