import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const runForgeVersion = "0.1.0";

export interface RunForgeVersionInfo {
  version: string;
  gitSha: string;
  upstream?: string;
  behindBy?: number;
}

export function getRunForgeVersionInfo(cwd = runForgeRoot()): RunForgeVersionInfo {
  const gitSha = gitOutput(["rev-parse", "--short", "HEAD"], cwd) ?? "unknown";
  const upstream = gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
  const counts = upstream ? gitOutput(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], cwd) : undefined;
  const behindBy = counts ? Number(counts.trim().split(/\s+/)[1]) : undefined;
  return {
    version: runForgeVersion,
    gitSha,
    upstream,
    behindBy: Number.isFinite(behindBy) ? behindBy : undefined
  };
}

function runForgeRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    if (existsSync(join(current, "package.json")) && (existsSync(join(current, "src")) || existsSync(join(current, "dist")))) {
      return current;
    }
    current = dirname(current);
  }
  return process.cwd();
}

function gitOutput(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}
