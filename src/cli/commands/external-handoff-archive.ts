import { Command, InvalidArgumentError } from "commander";
import { buildHandoffArchive, renderHandoffArchiveMarkdown, renderHandoffSearchMarkdown, renderHandoffSearchTable, searchHandoffArchive, validateHandoffArchiveFile } from "../../run/external-operator-handoff-archive.js";

export function handoffArchiveCommand(): Command {
  return new Command("handoff-archive")
    .description("Build a read-only searchable archive over operator handoff and audit artifacts.")
    .requiredOption("--root <artifact-root>", "artifact root to scan for handoff/audit files")
    .requiredOption("--out <archive-output-root>", "archive output directory")
    .action(async (opts) => {
      try {
        const archive = await buildHandoffArchive({ root: opts.root as string, out: opts.out as string });
        console.log(renderHandoffArchiveMarkdown(archive));
        if (!archive.validation.passed) process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

export function handoffSearchCommand(): Command {
  return new Command("handoff-search")
    .description("Search a handoff archive by repo, decision, audit, safety, validation, or mutation status.")
    .requiredOption("--archive <archive-json>", "handoff-archive.json path")
    .option("--out <search-output-root>", "optional search output directory")
    .option("--format <format>", "output format: table, json, or md (default: table)", parseArchiveFormat)
    .option("--repo <substring>", "repo path/name substring")
    .option("--decision <verdict>", "decision verdict filter")
    .option("--audit-status <status>", "audit status filter")
    .option("--safety-status <status>", "safety status filter")
    .option("--validation-status <status>", "after-validation status filter")
    .option("--original-mutated <verdict>", "original mutation filter: true/false/mutated/unchanged")
    .action(async (opts) => {
      try {
        const result = await searchHandoffArchive({
          archive: opts.archive as string,
          out: opts.out as string | undefined,
          format: opts.format as "table" | "json" | "md" | undefined,
          filters: {
            repo: opts.repo as string | undefined,
            decision: opts.decision as string | undefined,
            auditStatus: opts.auditStatus as string | undefined,
            safetyStatus: opts.safetyStatus as string | undefined,
            validationStatus: opts.validationStatus as string | undefined,
            originalMutated: opts.originalMutated as string | undefined
          }
        });
        if (opts.format === "json") console.log(JSON.stringify(result, null, 2));
        else if (opts.format === "md") console.log(renderHandoffSearchMarkdown(result));
        else console.log(renderHandoffSearchTable(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

export function handoffArchiveValidateCommand(): Command {
  return new Command("handoff-archive-validate")
    .description("Validate a handoff archive for duplicate IDs, unsafe mutations, malformed paths, and incomplete records.")
    .requiredOption("--archive <archive-json>", "handoff-archive.json path")
    .action(async (opts) => {
      try {
        const validation = await validateHandoffArchiveFile(opts.archive as string);
        console.log(JSON.stringify(validation, null, 2));
        if (!validation.passed) process.exitCode = 1;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function parseArchiveFormat(value: string): "table" | "json" | "md" {
  if (value === "table" || value === "json" || value === "md") return value;
  throw new InvalidArgumentError("--format must be table, json, or md.");
}
