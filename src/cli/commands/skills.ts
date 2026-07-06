import { Command, InvalidArgumentError } from "commander";
import { buildSkillCuratorReport } from "../../run/skill-curator-report.js";
import { buildSkillInventory } from "../../run/skill-inventory.js";

export function skillsCommand(): Command {
  const skills = new Command("skills").description("Inspect RunForge skill lifecycle candidates.");
  skills.addCommand(inventoryCommand());
  skills.addCommand(curatorReportCommand());
  return skills;
}

function inventoryCommand(): Command {
  return new Command("inventory")
    .description("Inventory repo-local and Codex skills without mutating them.")
    .requiredOption("--out <out-dir>", "output directory for inventory files")
    .option("--root <skill-root...>", "skill roots to inspect")
    .action(async (opts) => {
      try {
        const result = await buildSkillInventory({
          out: opts.out as string,
          roots: opts.root as string[] | undefined
        });
        console.log(`Skills inventory written: ${result.markdownPath}`);
        console.log(`Skills found: ${result.skills.length}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function curatorReportCommand(): Command {
  return new Command("curator-report")
    .description("Generate a curator report of candidate skills from RunForge evidence.")
    .requiredOption("--runs <runs-dir>", "validation run root to reference")
    .requiredOption("--out <out-dir>", "output directory for curator report files")
    .action(async (opts) => {
      try {
        const result = await buildSkillCuratorReport({
          runs: opts.runs as string,
          out: opts.out as string
        });
        console.log(`Skill curator report written: ${result.markdownPath}`);
        console.log(`Candidates: ${result.candidates.length}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}
