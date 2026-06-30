import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { Command } from "commander";
import { runningInContainer, unsafeMountWarnings } from "../../security/docker-policy.js";

const execFileAsync = promisify(execFile);

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check local RunForge environment.")
    .action(async () => {
      const pnpm = await versionOrMissing("pnpm", ["--version"]);
      const docker = await versionOrMissing("docker", ["--version"]);
      const warnings = unsafeMountWarnings();
      console.log(`Node: ${process.version}`);
      console.log(`pnpm: ${pnpm}`);
      console.log(`Docker: ${docker}`);
      console.log(`OS: ${platform()}`);
      console.log(`Inside container: ${runningInContainer() ? "yes" : "no"}`);
      console.log(`Unsafe mount warnings: ${warnings.length > 0 ? warnings.join("; ") : "none"}`);
      console.log(`Status: ${warnings.length > 0 ? "warning" : "ok"}`);
    });
}

async function versionOrMissing(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args);
    return stdout.trim();
  } catch {
    return "not available";
  }
}
