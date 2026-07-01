import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DOGFOOD_RAILS_OUT_ROOT = "artifacts/runs/dogfood-rails";
export const RUNFORGE_BUILT_CLI = "dist/src/cli/index.js";

export const DOGFOOD_RAILS_CHECKS = [
  { slug: "01-check-structure", command: "pnpm check:structure" },
  { slug: "02-check-governance", command: "pnpm check:governance" },
  { slug: "03-typecheck", command: "pnpm typecheck" },
  { slug: "04-test", command: "pnpm test" },
  { slug: "05-build", command: "pnpm build" },
  { slug: "06-validation-run", command: "pnpm validation:run" }
] as const;

export const REQUIRED_DOGFOOD_RAILS_ARTIFACTS = [
  "run.json",
  "review.md",
  "trajectory.json",
  "safety-report.json",
  "context-summary.json",
  "command-result.json",
  "command-output.txt"
] as const;

export const COMMAND_RESULT_KEYS = [
  "blockReason",
  "blocked",
  "command",
  "errorSummary",
  "executed",
  "exitCode",
  "signal",
  "stderr",
  "stdout"
] as const;

interface DogfoodRun {
  slug: string;
  command: string;
  runDir: string;
  status: string;
}

export async function runDogfoodRails(repoPath = process.cwd()): Promise<DogfoodRun[]> {
  const outRoot = resolve(repoPath, DOGFOOD_RAILS_OUT_ROOT);
  const runs: DogfoodRun[] = [];

  for (const check of DOGFOOD_RAILS_CHECKS) {
    const outDir = join(outRoot, check.slug);
    await mkdir(outDir, { recursive: true });
    const before = await childDirectories(outDir);
    const args = [
      RUNFORGE_BUILT_CLI,
      "run",
      "--task",
      "command-check",
      "--repo",
      repoPath,
      "--command",
      check.command,
      "--safety-profile",
      "trusted-local",
      "--out",
      outDir
    ];

    console.log(`\n[dogfood:rails] ${check.command}`);
    const cli = spawnSync("node", args, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
    if (cli.stdout) process.stdout.write(cli.stdout);
    if (cli.stderr) process.stderr.write(cli.stderr);
    if (cli.error) throw cli.error;
    if (cli.status !== 0) throw new Error(`runforge command-check wrapper failed for ${check.command}`);

    const runDir = await newRunDir(outDir, before);
    await assertDogfoodArtifacts(runDir);
    const runRecord = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as { status?: string };
    const commandResult = await readCommandResult(join(runDir, "command-result.json"));

    if (runRecord.status !== "passed" || commandResult.exitCode !== 0 || commandResult.executed !== true) {
      throw new Error(`${check.command} failed inside dogfood rails. Inspect ${runDir}`);
    }

    runs.push({ slug: check.slug, command: check.command, runDir, status: runRecord.status });
  }

  console.log("\n[dogfood:rails] artifact roots");
  for (const run of runs) console.log(`${run.slug}: ${run.runDir}`);
  return runs;
}

export async function assertDogfoodArtifacts(runDir: string): Promise<void> {
  for (const artifact of REQUIRED_DOGFOOD_RAILS_ARTIFACTS) {
    await access(join(runDir, artifact));
  }
  await readCommandResult(join(runDir, "command-result.json"));
}

async function readCommandResult(path: string): Promise<Record<string, unknown>> {
  const result = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (JSON.stringify(keys) !== JSON.stringify(COMMAND_RESULT_KEYS)) {
    throw new Error(`command-result.json has unstable keys: ${keys.join(", ")}`);
  }
  for (const key of ["blockReason", "exitCode", "signal", "errorSummary"]) {
    if (!(key in result)) throw new Error(`command-result.json missing nullable key: ${key}`);
  }
  return result;
}

async function newRunDir(outDir: string, before: Set<string>): Promise<string> {
  const after = await childDirectories(outDir);
  const created = [...after].filter((entry) => !before.has(entry));
  if (created.length !== 1) {
    throw new Error(`Expected exactly one new run directory in ${outDir}, found ${created.length}.`);
  }
  return join(outDir, created[0]);
}

async function childDirectories(path: string): Promise<Set<string>> {
  const entries = await readdir(path, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => basename(entry.name)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDogfoodRails().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
