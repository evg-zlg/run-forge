import { Command, InvalidArgumentError } from "commander";
import { recordFactoryCandidateVerdict, runFactoryOps } from "../../run/factory-ops.js";
import { runFactoryOpsInbox } from "../../run/factory-ops-inbox.js";

export function factoryCommand(): Command {
  const factory = new Command("factory").description("Discover projects and run bounded operational factory batches.");
  const ops = new Command("ops").description("Discover and run bounded project operations.");
  ops.addCommand(new Command("run")
    .option("--repo <path>", "unknown repository path to discover")
    .option("--project <name-or-path>", "optional cached registry alias or path")
    .option("--profile <profile>")
    .option("--batch-size <number>", "maximum candidates", (value) => Number(value), 3)
    .option("--out <directory>", "evidence output directory", "validation/runs/factory-ops-latest")
    .option("--registry <file>")
    .option("--profiles <file>")
    .option("--cache <directory>", "rebuildable learned project cache")
    .option("--reopen-candidate <id>", "explicitly reopen one reviewed-no-change fingerprint", collect, [])
    .option("--autopilot", "execute authority-covered low-risk candidates without owner prompts", false)
    .action(async (opts) => {
      try { console.log(JSON.stringify(await runFactoryOps({ repo: opts.repo, project: opts.project, profile: opts.profile, batchSize: opts.batchSize, out: opts.out, registry: opts.registry, profiles: opts.profiles, cache: opts.cache, autopilot: opts.autopilot, reopenCandidates: opts.reopenCandidate }), null, 2)); }
      catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    }));
  ops.addCommand(new Command("candidate-verdict")
    .description("Record a fingerprint-bound owner verdict for one discovered candidate.")
    .requiredOption("--repo <path>")
    .requiredOption("--candidate <id>")
    .requiredOption("--verdict <verdict>")
    .requiredOption("--classification <classification>")
    .requiredOption("--reason <reason>")
    .requiredOption("--check <evidence>", "validation evidence (repeatable)", collect, [])
    .requiredOption("--out <directory>")
    .option("--cache <directory>")
    .action(async (opts) => {
      try {
        if (opts.verdict !== "reviewed_no_change" || opts.classification !== "false_positive") throw new Error("Supported verdict is reviewed_no_change / false_positive.");
        console.log(JSON.stringify(await recordFactoryCandidateVerdict({ repo: opts.repo, candidate: opts.candidate, verdict: opts.verdict, classification: opts.classification, reason: opts.reason, checks: opts.check, out: opts.out, cache: opts.cache }), null, 2));
      } catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    }));
  ops.addCommand(new Command("inbox")
    .description("Build a read-only owner inbox across multiple projects.")
    .option("--repo <path>", "repository path to inspect (repeatable)", collect, [])
    .option("--project-set <name>", "known project set (all-known)")
    .option("--out <directory>", "evidence output directory", "validation/runs/factory-ops-inbox-latest")
    .option("--stale-days <number>", "age after which an item is stale", (value) => Number(value), 14)
    .action(async (opts) => {
      try { console.log(JSON.stringify(await runFactoryOpsInbox({ repos: opts.repo, projectSet: opts.projectSet, out: opts.out, staleDays: opts.staleDays }), null, 2)); }
      catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    }));
  factory.addCommand(ops);
  return factory;
}

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
