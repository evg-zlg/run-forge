import { mkdir, writeFile } from "node:fs/promises";
import { Command } from "commander";

export function initCommand(): Command {
  return new Command("init")
    .description("Create local RunForge defaults.")
    .option("--safe", "write safe local defaults", false)
    .action(async (opts) => {
      const dir = "runforge-artifacts";
      await mkdir(dir, { recursive: true });
      await mkdir(".runforge", { recursive: true });
      await writeFile(".runforge/policy.json", `${JSON.stringify({
        safe: Boolean(opts.safe),
        writeRepo: false,
        writeArtifacts: true,
        runCommands: false
      }, null, 2)}\n`, "utf8");
      console.log(`Initialized RunForge safe defaults in .runforge/ and ${dir}/`);
    });
}
