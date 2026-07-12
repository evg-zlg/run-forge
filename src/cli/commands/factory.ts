import { Command, InvalidArgumentError } from "commander";
import { runFactoryOps } from "../../run/factory-ops.js";

export function factoryCommand(): Command {
  const factory = new Command("factory").description("Run project-registry-backed operational factory batches.");
  const ops = new Command("ops").description("Discover and run bounded project operations.");
  ops.addCommand(new Command("run")
    .requiredOption("--project <name-or-path>")
    .option("--profile <profile>")
    .option("--batch-size <number>", "maximum candidates", (value) => Number(value), 3)
    .requiredOption("--out <directory>")
    .option("--registry <file>")
    .option("--profiles <file>")
    .action(async (opts) => {
      try { console.log(JSON.stringify(await runFactoryOps({ project: opts.project, profile: opts.profile, batchSize: opts.batchSize, out: opts.out, registry: opts.registry, profiles: opts.profiles }), null, 2)); }
      catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
    }));
  factory.addCommand(ops);
  return factory;
}
