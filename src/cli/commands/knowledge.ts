import { Command, InvalidArgumentError } from "commander";
import { exportOkfBundle, validateOkfBundle } from "../../run/okf-knowledge-export.js";

export function knowledgeCommand(): Command {
  const knowledge = new Command("knowledge").description("Export and validate RunForge knowledge bundles.");
  knowledge.addCommand(exportOkfCommand());
  knowledge.addCommand(validateOkfCommand());
  return knowledge;
}

function exportOkfCommand(): Command {
  return new Command("export-okf")
    .description("Export validation evidence as an OKF-compatible markdown bundle.")
    .requiredOption("--root <root-dir>", "validation run root to scan")
    .requiredOption("--out <out-dir>", "output directory for the knowledge bundle")
    .action(async (opts) => {
      try {
        const result = await exportOkfBundle({ root: opts.root as string, out: opts.out as string });
        console.log(`OKF knowledge bundle written: ${result.out}`);
        console.log(`Generated files: ${result.files.length}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function validateOkfCommand(): Command {
  return new Command("validate-okf")
    .description("Validate an exported RunForge OKF markdown bundle.")
    .requiredOption("--bundle <bundle-dir>", "knowledge bundle directory to validate")
    .action(async (opts) => {
      try {
        const result = await validateOkfBundle(opts.bundle as string);
        console.log(result.ok ? `OKF bundle valid: ${opts.bundle}` : `OKF bundle invalid: ${opts.bundle}`);
        for (const error of result.errors) console.log(`- ${error}`);
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}
