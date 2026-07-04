import { Command, InvalidArgumentError } from "commander";
import { inspectPacket, renderPacketInspection, type PacketInspectFormat } from "../../run/packet-inspector.js";

export function packetCommand(): Command {
  const packet = new Command("packet").description("Inspect RunForge packet artifacts.");
  packet.addCommand(inspectCommand());
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
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    });
}

function parseFormat(value: string): PacketInspectFormat {
  if (value === "text" || value === "json" || value === "mermaid") return value;
  throw new InvalidArgumentError("--format must be text, json, or mermaid.");
}
