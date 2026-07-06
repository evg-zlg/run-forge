import { Command, InvalidArgumentError } from "commander";
import { buildPacketIndex, renderPacketIndexText } from "../../run/packet-indexer.js";
import { inspectPacket, renderPacketInspection, type PacketInspectFormat } from "../../run/packet-inspector.js";
import { exportPacketViewer, exportPacketViewersForIndex, renderViewerIndexSummary } from "../../run/packet-viewer.js";
import {
  buildDashboardSeed,
  buildLatestDogfoodReport,
  queryPacketIndex,
  type PacketQueryFormat
} from "../../run/packet-query.js";
import { renderLatestDogfoodMarkdown, renderPacketQuery } from "../../run/packet-query-renderer.js";

export function packetCommand(): Command {
  const packet = new Command("packet").description("Inspect RunForge packet artifacts.");
  packet.addCommand(inspectCommand());
  packet.addCommand(indexCommand());
  packet.addCommand(queryCommand());
  packet.addCommand(reportCommand());
  packet.addCommand(viewCommand());
  packet.addCommand(viewIndexCommand());
  return packet;
}

function inspectCommand(): Command {
  return new Command("inspect")
    .description("Print a concise packet route, status, and artifact view.")
    .requiredOption("--packet <packet-dir>", "packet directory to inspect")
    .option("--format <format>", "output format: text, json, or mermaid (default: text)", parseFormat)
    .option("--validate", "validate required packet artifacts and key JSON fields")
    .action(async (opts) => {
      try {
        const inspection = await inspectPacket({
          packet: opts.packet as string,
          format: opts.format as PacketInspectFormat | undefined,
          validate: Boolean(opts.validate)
        });
        console.log(renderPacketInspection(inspection, opts.format as PacketInspectFormat | undefined));
        if (inspection.validation && !inspection.validation.passed) {
          process.exitCode = 1;
        }
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function indexCommand(): Command {
  return new Command("index")
    .description("Build a compact index across validation runs and packet directories.")
    .requiredOption("--root <root-dir>", "validation run root to scan")
    .option("--out <out-dir>", "directory for index.md and index.json")
    .option("--dashboard-seed", "also write dashboard-seed.json to the output directory")
    .action(async (opts) => {
      try {
        const result = await buildPacketIndex({
          root: opts.root as string,
          out: opts.out as string | undefined
        });
        if (opts.dashboardSeed) {
          if (!opts.out) throw new Error("--dashboard-seed requires --out.");
          await buildDashboardSeed({
            root: opts.root as string,
            out: opts.out as string
          });
        }
        console.log(renderPacketIndexText(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function queryCommand(): Command {
  return new Command("query")
    .description("Filter and summarize an existing packet index.")
    .requiredOption("--index <index-json>", "packet index JSON to query")
    .option("--out <out-dir>", "directory for query.md and query.json")
    .option("--format <format>", "console output format: table, json, or md (default: table)", parseQueryFormat)
    .option("--repo <repo>", "filter by repo name or path")
    .option("--outcome <outcome>", "filter by outcome")
    .option("--provider-status <status>", "filter by provider status")
    .option("--mutation-verdict <verdict>", "filter by external repo mutation verdict")
    .option("--scenario <scenario>", "filter by scenario")
    .option("--alpha <alpha>", "filter by alpha/milestone")
    .action(async (opts) => {
      try {
        const result = await queryPacketIndex({
          index: opts.index as string,
          out: opts.out as string | undefined,
          format: opts.format as PacketQueryFormat | undefined,
          filters: {
            repo: opts.repo as string | undefined,
            outcome: opts.outcome as string | undefined,
            providerStatus: opts.providerStatus as string | undefined,
            mutationVerdict: opts.mutationVerdict as string | undefined,
            scenario: opts.scenario as string | undefined,
            alpha: opts.alpha as string | undefined
          }
        });
        console.log(renderPacketQuery(result, opts.format as PacketQueryFormat | undefined));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function reportCommand(): Command {
  const report = new Command("report").description("Generate packet evidence reports.");
  report.addCommand(latestReportCommand());
  return report;
}

function latestReportCommand(): Command {
  return new Command("latest")
    .description("Summarize the latest indexed dogfood evidence.")
    .requiredOption("--root <root-dir>", "validation run root to scan")
    .option("--out <out-dir>", "directory for latest-dogfood.md and latest-dogfood.json")
    .action(async (opts) => {
      try {
        const result = await buildLatestDogfoodReport({
          root: opts.root as string,
          out: opts.out as string | undefined
        });
        console.log(renderLatestDogfoodMarkdown(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function viewCommand(): Command {
  return new Command("view")
    .description("Export a local static HTML viewer for a packet.")
    .requiredOption("--packet <packet-dir>", "packet directory to view")
    .requiredOption("--out <out-dir>", "output directory for index.html")
    .action(async (opts) => {
      try {
        const result = await exportPacketViewer({
          packet: opts.packet as string,
          out: opts.out as string
        });
        console.log(`Packet viewer written: ${result.indexPath}`);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function viewIndexCommand(): Command {
  return new Command("view-index")
    .description("Render static HTML viewers for packetPath records in an existing packet index.")
    .requiredOption("--index <index-json>", "packet index JSON with entries containing packetPath")
    .requiredOption("--out <out-dir>", "output directory for rendered viewers and summary files")
    .option("--strict", "fail if any indexed packet cannot be rendered")
    .action(async (opts) => {
      try {
        const result = await exportPacketViewersForIndex({
          index: opts.index as string,
          out: opts.out as string,
          strict: Boolean(opts.strict)
        });
        console.log(renderViewerIndexSummary(result));
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function parseFormat(value: string): PacketInspectFormat {
  if (value === "text" || value === "json" || value === "mermaid") return value;
  throw new InvalidArgumentError("--format must be text, json, or mermaid.");
}

function parseQueryFormat(value: string): PacketQueryFormat {
  if (value === "table" || value === "json" || value === "md") return value;
  throw new InvalidArgumentError("--format must be table, json, or md.");
}
