import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-11");
const root = join(repo, "validation/runs");

const outputs = {
  index: "/tmp/runforge-alpha11-index",
  queryReady: "/tmp/runforge-alpha11-query-ready",
  queryRejected: "/tmp/runforge-alpha11-query-rejected",
  queryRepo: "/tmp/runforge-alpha11-query-repo",
  queryMutation: "/tmp/runforge-alpha11-query-mutation",
  queryEmpty: "/tmp/runforge-alpha11-query-empty",
  latest: "/tmp/runforge-alpha11-latest-report",
  seed: "/tmp/runforge-alpha11-dashboard-seed"
};

interface CommandResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface QueryJson {
  matchingCount: number;
  records: Array<{
    alpha: string;
    repo: string;
    scenario: string;
    outcome: string;
    providerStatus: string;
    mutationVerdict: string;
  }>;
}

interface LatestJson {
  latestAlpha: string;
  dogfoodCaseCount: number;
  counts: {
    byOutcome: Record<string, number>;
    byProviderStatus: Record<string, number>;
    byMutationVerdict: Record<string, number>;
  };
  reposTested: string[];
  originalReposStayedUnchanged: boolean;
}

interface DashboardSeedJson {
  schemaVersion: string;
  records: unknown[];
  summary: {
    total: number;
    byOutcome: Record<string, number>;
    byRepo: Record<string, number>;
    byProviderStatus: Record<string, number>;
  };
}

interface Alpha11Results {
  schemaVersion: "alpha-11-results";
  generatedAt: string;
  outputs: typeof outputs;
  checks: {
    alpha9And10Ready: number;
    alpha9And10Rejected: number;
    alpha9And10Smartsql: number;
    alpha9And10Unchanged: number;
    emptyMatches: number;
    invalidIndexExitCode: number;
    latestAlpha: string;
    latestDogfoodCaseCount: number;
    seedRecords: number;
  };
  commands: Array<{
    command: string;
    status: "passed" | "failed";
    exitCode: number;
  }>;
  errors: string[];
}

for (const out of Object.values(outputs)) {
  await rm(out, { recursive: true, force: true });
}
await mkdir(validationDir, { recursive: true });

const commands: CommandResult[] = [];
const errors: string[] = [];

commands.push(await runCli(["packet", "index", "--root", root, "--out", outputs.index]));
commands.push(await runCli(["packet", "query", "--index", join(outputs.index, "index.json"), "--out", outputs.queryReady, "--outcome", "proposal_ready_verified"]));
commands.push(await runCli(["packet", "query", "--index", join(outputs.index, "index.json"), "--out", outputs.queryRejected, "--outcome", "provider_rejected"]));
commands.push(await runCli(["packet", "query", "--index", join(outputs.index, "index.json"), "--out", outputs.queryRepo, "--repo", "smartsql"]));
commands.push(await runCli(["packet", "query", "--index", join(outputs.index, "index.json"), "--out", outputs.queryMutation, "--mutation-verdict", "unchanged"]));
commands.push(await runCli(["packet", "query", "--index", join(outputs.index, "index.json"), "--out", outputs.queryEmpty, "--scenario", "does-not-exist"]));
commands.push(await runCli(["packet", "report", "latest", "--root", root, "--out", outputs.latest]));
commands.push(await runCli(["packet", "index", "--root", root, "--out", outputs.seed, "--dashboard-seed"]));

const invalidIndex = await runCli(["packet", "query", "--index", "/tmp/runforge-alpha11-missing-index.json"]);
commands.push({
  ...invalidIndex,
  status: invalidIndex.exitCode === 0 ? "failed" : "passed"
});

for (const command of commands.slice(0, -1)) {
  if (command.exitCode !== 0) errors.push(`${command.command} failed with exit ${command.exitCode}`);
}
if (invalidIndex.exitCode === 0) errors.push("invalid index path unexpectedly succeeded");
if (!invalidIndex.stderr.includes("Unable to read packet index")) errors.push("invalid index path did not fail clearly");

const ready = await readJson<QueryJson>(join(outputs.queryReady, "query.json"));
const rejected = await readJson<QueryJson>(join(outputs.queryRejected, "query.json"));
const smartsql = await readJson<QueryJson>(join(outputs.queryRepo, "query.json"));
const mutation = await readJson<QueryJson>(join(outputs.queryMutation, "query.json"));
const empty = await readJson<QueryJson>(join(outputs.queryEmpty, "query.json"));
const latest = await readJson<LatestJson>(join(outputs.latest, "latest-dogfood.json"));
const seed = await readJson<DashboardSeedJson>(join(outputs.seed, "dashboard-seed.json"));

const alpha9And10Ready = ready.records.filter((record) => record.alpha === "ALPHA-9" || record.alpha === "ALPHA-10");
const alpha9And10Rejected = rejected.records.filter((record) => record.alpha === "ALPHA-9" || record.alpha === "ALPHA-10");
const alpha9And10Smartsql = smartsql.records.filter((record) => record.alpha === "ALPHA-9" || record.alpha === "ALPHA-10");
const alpha9And10Unchanged = mutation.records.filter((record) => record.alpha === "ALPHA-9" || record.alpha === "ALPHA-10");

if (alpha9And10Ready.length !== 3) errors.push(`expected 3 Alpha-9/Alpha-10 verified proposals, got ${alpha9And10Ready.length}`);
if (alpha9And10Rejected.length !== 3) errors.push(`expected 3 Alpha-9/Alpha-10 provider rejections, got ${alpha9And10Rejected.length}`);
if (alpha9And10Smartsql.length !== 5) errors.push(`expected 5 Alpha-9/Alpha-10 smartsql entries, got ${alpha9And10Smartsql.length}`);
if (alpha9And10Unchanged.length !== 6) errors.push(`expected 6 Alpha-9/Alpha-10 unchanged entries, got ${alpha9And10Unchanged.length}`);
if (empty.matchingCount !== 0) errors.push(`empty query returned ${empty.matchingCount} matches`);
if (!latest.latestAlpha || latest.latestAlpha !== "ALPHA-10") errors.push(`latest alpha should be ALPHA-10, got ${latest.latestAlpha}`);
if (latest.dogfoodCaseCount < 6) errors.push(`latest dogfood report should include at least 6 dogfood cases, got ${latest.dogfoodCaseCount}`);
if (latest.counts.byOutcome.proposal_ready_verified < 3) errors.push("latest dogfood report missing verified proposal count");
if (latest.counts.byProviderStatus.rejected < 3) errors.push("latest dogfood report missing rejected provider count");
if (!latest.reposTested.includes("smartsql")) errors.push("latest dogfood report missing smartsql repo");
if (!latest.originalReposStayedUnchanged) errors.push("latest dogfood report should show original repos unchanged");
if (seed.schemaVersion !== "alpha-11-dashboard-seed") errors.push(`dashboard seed schema mismatch: ${seed.schemaVersion}`);
if (seed.summary.total !== seed.records.length) errors.push("dashboard seed total does not match records length");
if ((seed.summary.byOutcome.provider_rejected ?? 0) < 3) errors.push("dashboard seed missing provider_rejected summary");
if (!("smartsql" in seed.summary.byRepo)) errors.push("dashboard seed missing smartsql repo summary");

const results: Alpha11Results = {
  schemaVersion: "alpha-11-results",
  generatedAt: new Date().toISOString(),
  outputs,
  checks: {
    alpha9And10Ready: alpha9And10Ready.length,
    alpha9And10Rejected: alpha9And10Rejected.length,
    alpha9And10Smartsql: alpha9And10Smartsql.length,
    alpha9And10Unchanged: alpha9And10Unchanged.length,
    emptyMatches: empty.matchingCount,
    invalidIndexExitCode: invalidIndex.exitCode,
    latestAlpha: latest.latestAlpha,
    latestDogfoodCaseCount: latest.dogfoodCaseCount,
    seedRecords: seed.records.length
  },
  commands: commands.map((command) => ({
    command: command.command,
    status: command.status,
    exitCode: command.exitCode
  })),
  errors
};

await writeFile(join(validationDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
await writeFile(join(validationDir, "summary.md"), renderSummary(results), "utf8");

console.log(renderSummary(results));
if (errors.length > 0) process.exitCode = 1;

async function runCli(args: string[]): Promise<CommandResult> {
  const command = `pnpm --dir ${repo} dev ${args.join(" ")}`;
  const result = await spawnCommand("pnpm", ["--dir", repo, "dev", ...args], "/tmp");
  return {
    command,
    status: result.exitCode === 0 ? "passed" : "failed",
    ...result
  };
}

function spawnCommand(command: string, args: string[], cwd: string): Promise<Omit<CommandResult, "command" | "status">> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolveResult({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function renderSummary(results: Alpha11Results): string {
  const lines = [
    "# RunForge Alpha-11 Validation",
    "",
    `Generated at: ${results.generatedAt}`,
    "",
    "## Black-box Outputs",
    "",
    ...Object.entries(results.outputs).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Checks",
    "",
    `- Alpha-9/Alpha-10 proposal_ready_verified: ${results.checks.alpha9And10Ready}`,
    `- Alpha-9/Alpha-10 provider_rejected: ${results.checks.alpha9And10Rejected}`,
    `- Alpha-9/Alpha-10 smartsql entries: ${results.checks.alpha9And10Smartsql}`,
    `- Alpha-9/Alpha-10 unchanged mutation entries: ${results.checks.alpha9And10Unchanged}`,
    `- Empty query matches: ${results.checks.emptyMatches}`,
    `- Invalid index exit code: ${results.checks.invalidIndexExitCode}`,
    `- Latest alpha: ${results.checks.latestAlpha}`,
    `- Latest dogfood case count: ${results.checks.latestDogfoodCaseCount}`,
    `- Dashboard seed records: ${results.checks.seedRecords}`,
    "",
    "## Commands",
    "",
    ...results.commands.map((command) => `- ${command.status.toUpperCase()} ${command.command}`)
  ];
  if (results.errors.length > 0) {
    lines.push("", "## Errors", "", ...results.errors.map((error) => `- ${error}`));
  } else {
    lines.push("", "Alpha-11 validation: passed");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
