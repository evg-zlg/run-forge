import { Command, InvalidArgumentError } from "commander";
import { runFactoryOps } from "../../run/factory-ops.js";

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
    .action(async (opts) => {
      try { console.log(JSON.stringify(await runFactoryOps({ repo: opts.repo, project: opts.project, profile: opts.profile, batchSize: opts.batchSize, out: opts.out, registry: opts.registry, profiles: opts.profiles, cache: opts.cache }), null, 2)); }
      catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    }));
  factory.addCommand(ops);
  return factory;
}
