import { Command, InvalidArgumentError } from "commander";
import { renderExternalFailureTriageCliSummary, runExternalFailureTriage } from "../../run/external-failure-triage.js";
import { renderExternalCommandCheckCliSummary, runExternalCommandCheck } from "../../run/external-command-check.js";
import { buildExternalDocsProposalSpec, renderExternalDocsProposalSummary, runExternalDocsProposalPacket } from "../../run/external-docs-proposal.js";
import { renderExternalProposalReadinessCliSummary, runExternalProposalReadiness } from "../../run/external-proposal-readiness.js";
import { renderExternalCodeProposalCliSummary, runExternalCodeProposal } from "../../run/external-code-proposal.js";

export function externalCommand(): Command {
  const external = new Command("external").description("Run safe packet-producing workflows for explicitly declared external local repositories.");
  external.addCommand(checkCommand());
  external.addCommand(failureTriageCommand());
  external.addCommand(proposalReadinessCommand());
  external.addCommand(codeProposalCommand());
  external.addCommand(docsProposalCommand());
  return external;
}

function checkCommand(): Command {
  return new Command("check")
    .description("Run explicit local commands in a disposable external-repo workspace and write a trace packet.")
    .requiredOption("--repo <path>", "external local repository path")
    .option("--setup-command <command>", "setup/preflight command to run in the disposable workspace before main commands; repeatable", collect, [])
    .option("--setup-network-intent <intent>", "declared setup network intent: none, expected, or unknown (default: unknown)", parseSetupNetworkIntent)
    .option("--continue-after-setup-failure", "diagnostic mode: run main commands even when setup/preflight fails")
    .requiredOption("--command <command>", "command to run in the disposable workspace; repeatable", collect, [])
    .option("--out <artifact-dir>", "artifact output directory")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds (default: 120000)", parsePositiveInteger)
    .option("--max-log-bytes <bytes>", "maximum captured bytes per stdout/stderr log (default: 1000000)", parsePositiveInteger)
    .option("--run-id <id>", "run id recorded in packet metadata")
    .option("--exit-policy <policy>", "CLI exit semantics: packet exits 0 when a packet is produced; command-status exits non-zero for failed, timed_out, blocked, or error packets (default: packet)", parseExitPolicy)
    .action(async (opts) => {
      try {
        const result = await runExternalCommandCheck({
          repo: opts.repo as string,
          setupCommands: opts.setupCommand as string[] | undefined,
          setupNetworkIntent: opts.setupNetworkIntent as "none" | "expected" | "unknown" | undefined,
          continueAfterSetupFailure: Boolean(opts.continueAfterSetupFailure),
          commands: opts.command as string[],
          out: opts.out as string | undefined,
          timeoutMs: opts.timeoutMs as number | undefined,
          maxLogBytes: opts.maxLogBytes as number | undefined,
          runId: opts.runId as string | undefined,
          exitPolicy: opts.exitPolicy as "packet" | "command-status" | undefined
        });
        console.log(renderExternalCommandCheckCliSummary(result));
        process.exitCode = result.cliExitCode;
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function failureTriageCommand(): Command {
  return new Command("failure-triage")
    .description("Analyze an external check packet or command failure and write a human-readable triage packet.")
    .option("--from-check-packet <packet-dir>", "existing external check packet directory")
    .option("--repo <path>", "external local repository path; requires --command when --from-check-packet is omitted")
    .option("--setup-command <command>", "setup/preflight command passed to source external check; repeatable", collect, [])
    .option("--setup-network-intent <intent>", "declared setup network intent passed to source external check: none, expected, or unknown (default: unknown)", parseSetupNetworkIntent)
    .option("--continue-after-setup-failure", "diagnostic mode passed to source external check")
    .option("--command <command>", "command to run through external check before triage; repeatable", collect, [])
    .option("--out <artifact-dir>", "artifact output directory")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds when running a source check", parsePositiveInteger)
    .option("--max-log-bytes <bytes>", "maximum captured bytes per stdout/stderr log when running a source check", parsePositiveInteger)
    .option("--run-id <id>", "run id recorded in triage packet metadata")
    .action(async (opts) => {
      try {
        const result = await runExternalFailureTriage({
          fromCheckPacket: opts.fromCheckPacket as string | undefined,
          repo: opts.repo as string | undefined,
          setupCommands: opts.setupCommand as string[] | undefined,
          setupNetworkIntent: opts.setupNetworkIntent as "none" | "expected" | "unknown" | undefined,
          continueAfterSetupFailure: Boolean(opts.continueAfterSetupFailure),
          commands: opts.command as string[] | undefined,
          out: opts.out as string | undefined,
          timeoutMs: opts.timeoutMs as number | undefined,
          maxLogBytes: opts.maxLogBytes as number | undefined,
          runId: opts.runId as string | undefined
        });
        console.log(renderExternalFailureTriageCliSummary(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function proposalReadinessCommand(): Command {
  return new Command("proposal-readiness")
    .description("Decide whether a failure triage packet is safe to advance to a proposal-only code patch.")
    .option("--from-triage-packet <packet-dir>", "existing external failure triage packet directory")
    .option("--repo <path>", "external local repository path; requires --command when --from-triage-packet is omitted")
    .option("--setup-command <command>", "setup/preflight command passed to source external check; repeatable", collect, [])
    .option("--setup-network-intent <intent>", "declared setup network intent passed to source external check: none, expected, or unknown (default: unknown)", parseSetupNetworkIntent)
    .option("--continue-after-setup-failure", "diagnostic mode passed to source external check")
    .option("--command <command>", "command to run through check and triage before readiness; repeatable", collect, [])
    .option("--out <artifact-dir>", "artifact output directory")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds when running source commands", parsePositiveInteger)
    .option("--max-log-bytes <bytes>", "maximum captured bytes per stdout/stderr log", parsePositiveInteger)
    .option("--run-id <id>", "run id recorded in readiness packet metadata")
    .action(async (opts) => {
      try {
        const result = await runExternalProposalReadiness({
          fromTriagePacket: opts.fromTriagePacket as string | undefined,
          repo: opts.repo as string | undefined,
          setupCommands: opts.setupCommand as string[] | undefined,
          setupNetworkIntent: opts.setupNetworkIntent as "none" | "expected" | "unknown" | undefined,
          continueAfterSetupFailure: Boolean(opts.continueAfterSetupFailure),
          commands: opts.command as string[] | undefined,
          out: opts.out as string | undefined,
          timeoutMs: opts.timeoutMs as number | undefined,
          maxLogBytes: opts.maxLogBytes as number | undefined,
          runId: opts.runId as string | undefined
        });
        console.log(renderExternalProposalReadinessCliSummary(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function codeProposalCommand(): Command {
  return new Command("code-proposal")
    .description("Create and verify a proposal-only patch in a disposable workspace when readiness allows it.")
    .option("--from-readiness-packet <packet-dir>", "existing external proposal readiness packet directory")
    .option("--repo <path>", "external local repository path; requires --command when --from-readiness-packet is omitted")
    .option("--setup-command <command>", "setup/preflight command passed to source external check; repeatable", collect, [])
    .option("--setup-network-intent <intent>", "declared setup network intent passed to source external check: none, expected, or unknown (default: unknown)", parseSetupNetworkIntent)
    .option("--continue-after-setup-failure", "diagnostic mode passed to source external check")
    .option("--command <command>", "command to run through the combined flow and verification; repeatable", collect, [])
    .option("--out <artifact-dir>", "artifact output directory")
    .option("--timeout-ms <ms>", "per-command timeout in milliseconds", parsePositiveInteger)
    .option("--max-log-bytes <bytes>", "maximum captured bytes per stdout/stderr log", parsePositiveInteger)
    .option("--run-id <id>", "run id recorded in code proposal packet metadata")
    .option("--enable-provider-proposal", "explicitly allow provider-backed proposal after deterministic strategies do not match")
    .option("--provider <provider>", "provider backend for explicitly enabled proposal mode: cli", parseProvider)
    .option("--provider-command <command>", "CLI command to run in the bounded provider input directory")
    .action(async (opts) => {
      try {
        const result = await runExternalCodeProposal({
          fromReadinessPacket: opts.fromReadinessPacket as string | undefined,
          repo: opts.repo as string | undefined,
          setupCommands: opts.setupCommand as string[] | undefined,
          setupNetworkIntent: opts.setupNetworkIntent as "none" | "expected" | "unknown" | undefined,
          continueAfterSetupFailure: Boolean(opts.continueAfterSetupFailure),
          commands: opts.command as string[] | undefined,
          out: opts.out as string | undefined,
          timeoutMs: opts.timeoutMs as number | undefined,
          maxLogBytes: opts.maxLogBytes as number | undefined,
          runId: opts.runId as string | undefined,
          enableProviderProposal: Boolean(opts.enableProviderProposal),
          provider: opts.provider as "cli" | undefined,
          providerCommand: opts.providerCommand as string | undefined
        });
        console.log(renderExternalCodeProposalCliSummary(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function docsProposalCommand(): Command {
  return new Command("docs-proposal")
    .description("Create a proposal-only external docs packet from CLI flags.")
    .requiredOption("--repo <path>", "external local repository path")
    .requiredOption("--target <relative-path>", "target docs file relative to --repo")
    .option("--evidence <relative-path>", "scoped evidence file relative to --repo; repeatable", collect, [])
    .option("--anchor <text>", "exact anchor text in --target")
    .option("--anchor-file <path>", "file containing exact anchor text")
    .option("--insert <text>", "text to insert after --anchor")
    .option("--insert-file <path>", "file containing text to insert after --anchor")
    .option("--rationale <text>", "why the insertion is supported by the evidence")
    .option("--rationale-file <path>", "file containing why the insertion is supported by the evidence")
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
          anchor: opts.anchor as string | undefined,
          anchorFile: opts.anchorFile as string | undefined,
          insert: opts.insert as string | undefined,
          insertFile: opts.insertFile as string | undefined,
          rationale: opts.rationale as string | undefined,
          rationaleFile: opts.rationaleFile as string | undefined,
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
  throw new InvalidArgumentError("value must be a positive integer.");
}

function parseExitPolicy(value: string): "packet" | "command-status" {
  if (value === "packet" || value === "command-status") return value;
  throw new InvalidArgumentError("--exit-policy must be packet or command-status.");
}

function parseSetupNetworkIntent(value: string): "none" | "expected" | "unknown" {
  if (value === "none" || value === "expected" || value === "unknown") return value;
  throw new InvalidArgumentError("--setup-network-intent must be none, expected, or unknown.");
}

function parseProvider(value: string): "cli" {
  if (value === "cli") return value;
  throw new InvalidArgumentError("--provider must be cli.");
}
