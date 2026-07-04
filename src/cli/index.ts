#!/usr/bin/env node
import { Command } from "commander";
import { runForgeVersion } from "../core/version.js";
import { doctorCommand } from "./commands/doctor.js";
import { externalCommand } from "./commands/external.js";
import { initCommand } from "./commands/init.js";
import { packetCommand } from "./commands/packet.js";
import { runCommand } from "./commands/run.js";
import { triageCommand } from "./commands/triage.js";

const program = new Command();

program
  .name("runforge")
  .description("RunForge Agentic Engineering Harness")
  .version(runForgeVersion);

program.addCommand(doctorCommand());
program.addCommand(externalCommand());
program.addCommand(initCommand());
program.addCommand(packetCommand());
program.addCommand(runCommand());
program.addCommand(triageCommand());

await program.parseAsync();
