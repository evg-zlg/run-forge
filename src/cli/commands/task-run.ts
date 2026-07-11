import { Command, InvalidArgumentError } from "commander";
import { renderTaskRunCliSummary, runTaskRunHarness } from "../../run/task-run-harness.js";

export function taskRunCommand(): Command {
  const taskRun = new Command("task-run").description("Run a narrow repeatable Agent OS task-run harness.");
  taskRun.addCommand(startCommand());
  return taskRun;
}

function startCommand(): Command {
  return new Command("start")
    .description("Create plan, isolated subtask snapshots, reports, checks, summary, and results for one task run.")
    .requiredOption("--task <text>", "task input accepted by the harness")
    .requiredOption("--out <path>", "artifact output root, for example validation/runs/TASK-RUN-2")
    .option("--repo <path>", "external repository target; requires --runtime docker")
    .option("--command <command>", "external validation command; repeatable", collect, [])
    .option("--tmp-root <path>", "tmp workspace root")
    .option("--check-command <command>", "validation command to run", "corepack pnpm check:structure")
    .option("--delegated-review <mode>", "explicit delegated review lane; supported: 'mock', 'cli'")
    .option("--runtime <mode>", "subtask runtime; supported: 'local', 'docker'", "local")
    .option("--docker-image <image>", "prebuilt local image for --runtime docker", "runforge:local")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds", parsePositiveInteger, 300_000)
    .action(async (opts) => {
      try {
        const delegatedReview = parseDelegatedReview(opts.delegatedReview as string | undefined);
        const runtime = parseRuntime(opts.runtime as string);
        const result = await runTaskRunHarness({
          task: opts.task as string,
          out: opts.out as string,
          repo: opts.repo as string | undefined,
          commands: opts.command as string[],
          tmpRoot: opts.tmpRoot as string | undefined,
          checkCommand: opts.checkCommand as string | undefined,
          delegatedReview,
          runtime,
          dockerImage: opts.dockerImage as string,
          timeoutMs: opts.timeoutMs as number
        });
        console.log(renderTaskRunCliSummary(result));
        if (result.status !== "completed") process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError("--timeout-ms must be a positive integer.");
  return parsed;
}

function parseRuntime(value: string): "local" | "docker" {
  if (value === "local" || value === "docker") return value;
  throw new InvalidArgumentError("--runtime supports only 'local' or 'docker'.");
}

function parseDelegatedReview(value: string | undefined): "mock" | "cli" | undefined {
  if (value === undefined) return undefined;
  if (value === "mock" || value === "cli") return value;
  throw new InvalidArgumentError("--delegated-review supports only 'mock' or 'cli'.");
}
