import { Command, InvalidArgumentError } from "commander";
import { buildOnboardingReport, renderOnboarding } from "../../product/onboarding.js";

export function onboardingCommand(): Command {
  return new Command("onboarding")
    .description("Discover RunForge's stable local product contract; read-only unless project-file writing is explicit.")
    .option("--repo <path>", "target repository to inspect")
    .option("--format <format>", "output format: human or json", "human")
    .option("--write-project-file", "create RUNFORGE.md in the target without committing it", false)
    .action(async (opts) => {
      if (!['human', 'json'].includes(opts.format)) throw new InvalidArgumentError("--format must be human or json.");
      try {
        const report = await buildOnboardingReport({ repo: opts.repo, writeProjectFile: opts.writeProjectFile });
        console.log(opts.format === "json" ? JSON.stringify(report, null, 2) : renderOnboarding(report));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}
