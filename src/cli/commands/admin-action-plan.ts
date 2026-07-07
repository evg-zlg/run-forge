import { Command, InvalidArgumentError } from "commander";
import { writeActionPlanReport } from "../../admin/action-plan-report.js";
import { collectAdminData } from "../../admin/builder.js";
import { defaultAdminConfigPath, loadAdminConfig } from "../../admin/config.js";

export function actionPlanCommand(): Command {
  return new Command("action-plan")
    .description("Write a redacted local operator action plan without executing previewed commands.")
    .option("--config <config-json>", "admin config path", defaultAdminConfigPath())
    .requiredOption("--out <markdown-file>", "output Markdown report path")
    .action(async (opts) => {
      try {
        const loaded = await loadAdminConfig(opts.config as string);
        const data = await collectAdminData({ config: loaded.path });
        const out = await writeActionPlanReport({
          out: opts.out as string,
          data,
          config: loaded.config
        });
        console.log(`Admin action plan written: ${out}`);
        console.log(`Runs inspected: ${data.runs.length}`);
        console.log("Preview only: no commands were executed.");
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}
