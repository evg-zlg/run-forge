import { Command, InvalidArgumentError } from "commander";
import { renderTaskRunCliSummary, runTaskRunHarness } from "../../run/task-run-harness.js";
import { continueExternalExecution, recordOwnerDecision, renderExternalExecutionCliSummary, runExternalExecution } from "../../run/external-execution.js";

export function taskRunCommand(): Command {
  const taskRun = new Command("task-run").description("Run a narrow repeatable Agent OS task-run harness.");
  taskRun.addCommand(startCommand());
  taskRun.addCommand(ownerDecisionCommand());
  taskRun.addCommand(continueCommand());
  return taskRun;
}

function startCommand(): Command {
  return new Command("start")
    .description("Create plan, isolated subtask snapshots, reports, checks, summary, and results for one task run.")
    .requiredOption("--task <text>", "task input accepted by the harness")
    .requiredOption("--out <path>", "artifact output root, for example validation/runs/TASK-RUN-2")
    .option("--repo <path>", "external repository to snapshot without mutating the original")
    .option("--command <command>", "external validation command; repeatable", collect, [])
    .option("--tmp-root <path>", "tmp workspace root")
    .option("--check-command <command>", "validation command to run", "corepack pnpm check:structure")
    .option("--delegated-review <mode>", "explicit delegated review lane; supported: 'mock', 'cli'")
    .option("--runtime <mode>", "subtask runtime; supported: 'local', 'docker'", "local")
    .option("--docker-image <image>", "prebuilt local image for --runtime docker", "runforge:local")
    .option("--prepare-runtime <mode>", "explicit dependency preparation; supported: 'explicit'", "none")
    .option("--repair-mode <mode>", "external repair mode; supported: 'disposable'")
    .option("--authority <path>", "delegated owner authority envelope")
    .option("--approval-mode <mode>", "owner gate; supported: 'require-owner-decision'", "require-owner-decision")
    .option("--apply-mode <mode>", "apply during start; supported: 'none'", "none")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds", parsePositiveInteger, 300_000)
    .action(async (opts) => {
      try {
        if (opts.repairMode !== undefined) {
          const result = await runExternalExecution({
            task: opts.task as string,
            out: opts.out as string,
            repo: opts.repo as string | undefined,
            runtime: opts.runtime as string,
            dockerImage: opts.dockerImage as string,
            prepareRuntime: opts.prepareRuntime as string,
            repairMode: opts.repairMode as string,
            authority: opts.authority as string | undefined,
            approvalMode: opts.approvalMode as string,
            applyMode: opts.applyMode as string,
            commands: opts.command as string[],
            tmpRoot: opts.tmpRoot as string | undefined,
            timeoutMs: opts.timeoutMs as number
          });
          console.log(renderExternalExecutionCliSummary(result));
          if (!["passed", "needs owner approval"].includes(result.runforgeCapability)) process.exitCode = 1;
          return;
        }
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
          commands: opts.command as string[],
          prepareRuntime: parsePrepareRuntime(opts.prepareRuntime as string),
          timeoutMs: opts.timeoutMs as number
        });
        console.log(renderTaskRunCliSummary(result));
        if (result.status !== "completed") process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function ownerDecisionCommand(): Command {
  return new Command("owner-decision")
    .description("Record an explicit owner decision bound to an external execution packet.")
    .requiredOption("--run <path>", "external execution artifact root")
    .requiredOption("--decision <decision>", "approve, reject, continue, or hold")
    .requiredOption("--target-mode <mode>", "controlled-worktree")
    .requiredOption("--target-branch <branch>", "explicit non-main target branch")
    .requiredOption("--note <text>", "owner note")
    .action(async (opts) => {
      try {
        const result = await recordOwnerDecision({ run: opts.run as string, decision: opts.decision as string, targetMode: opts.targetMode as string, targetBranch: opts.targetBranch as string, ownerNote: opts.note as string });
        console.log(`Owner decision recorded: ${result.decisionId}\nArtifact: ${result.path}`);
      } catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    });
}

function continueCommand(): Command {
  return new Command("continue")
    .description("Validate the owner decision, apply to the selected controlled worktree, and validate it.")
    .requiredOption("--run <path>", "external execution artifact root")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds", parsePositiveInteger, 300_000)
    .action(async (opts) => {
      try {
        const result = await continueExternalExecution({ run: opts.run as string, timeoutMs: opts.timeoutMs as number });
        console.log(renderExternalExecutionCliSummary(result));
        if (result.runforgeCapability !== "passed") process.exitCode = 1;
      } catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
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
