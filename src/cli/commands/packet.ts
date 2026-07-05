import { Command, InvalidArgumentError } from "commander";
import { inspectPacket, renderPacketInspection, type PacketInspectFormat } from "../../run/packet-inspector.js";
import { exportPacketViewer } from "../../run/packet-viewer.js";

export function packetCommand(): Command {
  const packet = new Command("packet").description("Inspect RunForge packet artifacts.");
  packet.addCommand(inspectCommand());
  packet.addCommand(viewCommand());
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

function parseFormat(value: string): PacketInspectFormat {
  if (value === "text" || value === "json" || value === "mermaid") return value;
  throw new InvalidArgumentError("--format must be text, json, or mermaid.");
}
