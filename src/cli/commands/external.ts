import { Command, InvalidArgumentError } from "commander";
import { buildExternalDocsProposalSpec, renderExternalDocsProposalSummary, runExternalDocsProposalPacket } from "../../run/external-docs-proposal.js";

export function externalCommand(): Command {
  const external = new Command("external").description("Create proposal-only packets for explicitly declared external local repositories.");
  external.addCommand(docsProposalCommand());
  return external;
}

function docsProposalCommand(): Command {
  return new Command("docs-proposal")
    .description("Create a proposal-only external docs packet from CLI flags.")
    .requiredOption("--repo <path>", "external local repository path")
    .requiredOption("--target <relative-path>", "target docs file relative to --repo")
    .option("--evidence <relative-path>", "scoped evidence file relative to --repo; repeatable", collect, [])
    .requiredOption("--anchor <text>", "exact anchor text in --target")
    .requiredOption("--insert <text>", "text to insert after --anchor")
    .option("--rationale <text>", "why the insertion is supported by the evidence")
    .option("--out <artifact-dir>", "artifact output directory")
    .option("--run-id <id>", "safe artifact run id")
    .option("--artifact-namespace <name>", "safe artifact namespace")
    .option("--exclude <pattern>", "exclude pattern relative to --repo; repeatable", collect, undefined)
    .option("--max-bytes-per-file <bytes>", "maximum bytes per included file", parsePositiveInteger)
    .option("--preview-spec", "print the generated normalized RunSpec and exit")
    .action(async (opts) => {
      try {
        const input = {
          repo: opts.repo as string,
          target: opts.target as string,
          evidence: opts.evidence as string[],
          anchor: opts.anchor as string,
          insert: opts.insert as string,
          rationale: opts.rationale as string | undefined,
          out: opts.out as string | undefined,
          runId: opts.runId as string | undefined,
          artifactNamespace: opts.artifactNamespace as string | undefined,
          exclude: opts.exclude as string[] | undefined,
          maxBytesPerFile: opts.maxBytesPerFile as number | undefined
        };
        if (opts.previewSpec) {
          console.log(JSON.stringify(await buildExternalDocsProposalSpec(input), null, 2));
          return;
        }
        console.log(renderExternalDocsProposalSummary(await runExternalDocsProposalPacket(input)));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new InvalidArgumentError("--max-bytes-per-file must be a positive integer.");
}
