import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-12");
const root = join(repo, "validation/runs");
const invalidSeedPath = "/tmp/runforge-alpha12-invalid-seed.json";

const outputs = {
  index: "/tmp/runforge-alpha12-index",
  dashboard: "/tmp/runforge-alpha12-dashboard"
};

interface CommandResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DashboardData {
  schemaVersion: string;
  generatedAt: string;
  sourceSeedPath: string;
  summary: {
    total: number;
    latestAlpha: string;
    byOutcome: Record<string, number>;
    byRepo: Record<string, number>;
    byProviderStatus: Record<string, number>;
    verifiedProposals: number;
    rejectedProviderProposals: number;
    originalReposUnchanged: boolean;
  };
  records: Array<{
    outcome: string;
    providerStatus: string;
    safetyLabels: string[];
  }>;
}

interface Alpha12Results {
  schemaVersion: "alpha-12-results";
  generatedAt: string;
  outputs: typeof outputs;
  checks: {
    dashboardSchemaVersion: string;
    dashboardRecords: number;
    latestAlpha: string;
    verifiedProposals: number;
    rejectedProviderProposals: number;
    originalReposUnchanged: boolean;
    indexHtmlIncludesSummary: boolean;
    indexHtmlIncludesRecords: boolean;
    missingSeedExitCode: number;
    invalidSeedExitCode: number;
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
await writeFile(invalidSeedPath, JSON.stringify({ schemaVersion: "invalid", records: [] }), "utf8");

const commands: CommandResult[] = [];
const errors: string[] = [];

commands.push(await runCli(["packet", "index", "--root", root, "--out", outputs.index, "--dashboard-seed"]));
commands.push(await runCli(["dashboard", "build", "--seed", join(outputs.index, "dashboard-seed.json"), "--out", outputs.dashboard]));

const missingSeed = await runCli(["dashboard", "build", "--seed", "/tmp/runforge-alpha12-missing-seed.json", "--out", "/tmp/runforge-alpha12-missing-dashboard"]);
commands.push({ ...missingSeed, status: missingSeed.exitCode === 0 ? "failed" : "passed" });

const invalidSeed = await runCli(["dashboard", "build", "--seed", invalidSeedPath, "--out", "/tmp/runforge-alpha12-invalid-dashboard"]);
commands.push({ ...invalidSeed, status: invalidSeed.exitCode === 0 ? "failed" : "passed" });

for (const command of commands.slice(0, 2)) {
  if (command.exitCode !== 0) errors.push(`${command.command} failed with exit ${command.exitCode}`);
}
if (missingSeed.exitCode === 0) errors.push("missing seed unexpectedly succeeded");
if (!missingSeed.stderr.includes("Unable to read dashboard seed")) errors.push("missing seed did not fail clearly");
if (invalidSeed.exitCode === 0) errors.push("invalid seed unexpectedly succeeded");
if (!invalidSeed.stderr.includes("Invalid dashboard seed")) errors.push("invalid seed did not fail clearly");

const html = await readFile(join(outputs.dashboard, "index.html"), "utf8");
const dashboard = await readJson<DashboardData>(join(outputs.dashboard, "dashboard-data.json"));
const indexHtmlIncludesSummary = html.includes("Total records") && html.includes("By outcome");
const indexHtmlIncludesRecords = html.includes("proposal_ready_verified") && html.includes("provider_rejected");

if (dashboard.schemaVersion !== "alpha-12-dashboard") errors.push(`dashboard schema mismatch: ${dashboard.schemaVersion}`);
if (dashboard.sourceSeedPath !== join(outputs.index, "dashboard-seed.json")) errors.push("dashboard sourceSeedPath mismatch");
if (dashboard.summary.total !== dashboard.records.length) errors.push("dashboard total does not match records length");
if (dashboard.records.length < 6) errors.push(`expected at least 6 dashboard records, got ${dashboard.records.length}`);
if ((dashboard.summary.byOutcome.proposal_ready_verified ?? 0) < 3) errors.push("dashboard missing verified proposal count");
if ((dashboard.summary.byProviderStatus.rejected ?? 0) < 3) errors.push("dashboard missing provider rejection count");
if (dashboard.summary.verifiedProposals < 3) errors.push("dashboard missing verified proposal summary");
if (dashboard.summary.rejectedProviderProposals < 3) errors.push("dashboard missing rejected provider summary");
if (!dashboard.summary.originalReposUnchanged) errors.push("dashboard should show original repos unchanged");
if (!dashboard.records.some((record) => record.safetyLabels.includes("provider rejected"))) errors.push("dashboard missing provider rejected safety label");
if (!indexHtmlIncludesSummary) errors.push("dashboard HTML missing summary content");
if (!indexHtmlIncludesRecords) errors.push("dashboard HTML missing record content");

const results: Alpha12Results = {
  schemaVersion: "alpha-12-results",
  generatedAt: new Date().toISOString(),
  outputs,
  checks: {
    dashboardSchemaVersion: dashboard.schemaVersion,
    dashboardRecords: dashboard.records.length,
    latestAlpha: dashboard.summary.latestAlpha,
    verifiedProposals: dashboard.summary.verifiedProposals,
    rejectedProviderProposals: dashboard.summary.rejectedProviderProposals,
    originalReposUnchanged: dashboard.summary.originalReposUnchanged,
    indexHtmlIncludesSummary,
    indexHtmlIncludesRecords,
    missingSeedExitCode: missingSeed.exitCode,
    invalidSeedExitCode: invalidSeed.exitCode
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

function renderSummary(results: Alpha12Results): string {
  const lines = [
    "# RunForge Alpha-12 Validation",
    "",
    `Generated at: ${results.generatedAt}`,
    "",
    "## Black-box Outputs",
    "",
    ...Object.entries(results.outputs).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Checks",
    "",
    `- Dashboard schemaVersion: ${results.checks.dashboardSchemaVersion}`,
    `- Dashboard records: ${results.checks.dashboardRecords}`,
    `- Latest alpha: ${results.checks.latestAlpha}`,
    `- Verified proposals: ${results.checks.verifiedProposals}`,
    `- Provider rejections: ${results.checks.rejectedProviderProposals}`,
    `- Original repos unchanged: ${results.checks.originalReposUnchanged}`,
    `- HTML includes summary: ${results.checks.indexHtmlIncludesSummary}`,
    `- HTML includes records: ${results.checks.indexHtmlIncludesRecords}`,
    `- Missing seed exit code: ${results.checks.missingSeedExitCode}`,
    `- Invalid seed exit code: ${results.checks.invalidSeedExitCode}`,
    "",
    "## Commands",
    "",
    ...results.commands.map((command) => `- ${command.status.toUpperCase()} ${command.command}`)
  ];

  if (results.errors.length > 0) {
    lines.push("", "## Errors", "", ...results.errors.map((error) => `- ${error}`));
  } else {
    lines.push("", "Alpha-12 validation: passed");
  }

  return `${lines.join("\n")}\n`;
}
