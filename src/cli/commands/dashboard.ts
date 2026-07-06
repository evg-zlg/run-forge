import { Command, InvalidArgumentError } from "commander";
import { buildStaticDashboard } from "../../run/dashboard-builder.js";

export function dashboardCommand(): Command {
  const dashboard = new Command("dashboard").description("Build local static dashboards from RunForge seed data.");
  dashboard.addCommand(buildCommand());
  return dashboard;
}

function buildCommand(): Command {
  return new Command("build")
    .description("Build a local static operator dashboard.")
    .requiredOption("--seed <seed-json>", "dashboard-seed.json path")
    .requiredOption("--out <out-dir>", "output directory for index.html and dashboard-data.json")
    .action(async (opts) => {
      try {
        const result = await buildStaticDashboard({
          seed: opts.seed as string,
          out: opts.out as string
        });
        console.log(`Dashboard written: ${result.indexPath}`);
        console.log(`Dashboard data written: ${result.dataPath}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}
