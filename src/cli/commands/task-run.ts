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
    .option("--repo <path>", "external repository to snapshot without mutating the original")
    .option("--tmp-root <path>", "tmp workspace root")
    .option("--check-command <command>", "validation command to run", "corepack pnpm check:structure")
    .option("--delegated-review <mode>", "explicit delegated review lane; supported: 'mock', 'cli'")
    .option("--runtime <mode>", "subtask runtime; supported: 'local', 'docker'", "local")
    .option("--docker-image <image>", "prebuilt local image for --runtime docker", "runforge:local")
    .option("--prepare-runtime <mode>", "explicit dependency preparation; supported: 'explicit'", "none")
    .action(async (opts) => {
      try {
        const delegatedReview = parseDelegatedReview(opts.delegatedReview as string | undefined);
        const runtime = parseRuntime(opts.runtime as string);
        const result = await runTaskRunHarness({
          task: opts.task as string,
          out: opts.out as string,
          tmpRoot: opts.tmpRoot as string | undefined,
          checkCommand: opts.checkCommand as string | undefined,
          delegatedReview,
          runtime,
          dockerImage: opts.dockerImage as string,
          repo: opts.repo as string | undefined,
          prepareRuntime: parsePrepareRuntime(opts.prepareRuntime as string)
        });
        console.log(renderTaskRunCliSummary(result));
        if (result.status !== "completed") process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function parsePrepareRuntime(value: string): "none" | "explicit" {
  if (value === "none" || value === "explicit") return value;
  throw new InvalidArgumentError("--prepare-runtime supports only 'explicit' (or the default 'none').");
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
