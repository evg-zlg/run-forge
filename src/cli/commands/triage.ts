import { Command } from "commander";
import { runTriage } from "../../triage/triage-runner.js";

export function triageCommand(): Command {
  return new Command("triage")
    .description("Safely triage a failure log and write structured artifacts.")
    .requiredOption("--repo <path>", "repository/workspace path to inspect read-only")
    .requiredOption("--log <path>", "failure log path")
    .requiredOption("--out <path>", "artifact output directory")
    .option("--provider <provider>", "mock or openai-compatible", "mock")
    .option("--model <model>", "provider model name")
    .option("--allow-command <command...>", "explicitly allow a diagnostic command in future modes")
    .action(async (opts) => {
      await runTriage({
        repoPath: opts.repo,
        logPath: opts.log,
        outPath: opts.out,
        provider: opts.provider,
        model: opts.model,
        allowCommand: opts.allowCommand
      });
      console.log(`RunForge wrote triage artifacts to ${opts.out}`);
    });
}
