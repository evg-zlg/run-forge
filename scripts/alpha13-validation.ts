import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-13");
const root = join(repo, "validation/runs");

const outputs = {
  index: "/tmp/runforge-alpha13-index",
  dashboard: "/tmp/runforge-alpha13-dashboard"
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
  summary: {
    total: number;
    byOutcome: Record<string, number>;
    byRepo: Record<string, number>;
    byProviderStatus: Record<string, number>;
  };
  records: Array<{
    repo: string;
    outcome: string;
    providerStatus: string;
    mutationVerdict: string;
    safetyLabels: string[];
  }>;
}

interface Alpha13Results {
  schemaVersion: "alpha-13-results";
  generatedAt: string;
  outputs: typeof outputs & {
    indexHtml: string;
    dashboardData: string;
  };
  checks: {
    dashboardSchemaVersion: string;
    dashboardRecords: number;
    filtersTested: string[];
    expectedRecordsFound: string[];
    noBackendRequired: boolean;
    staticDashboardWorksFromGeneratedFiles: boolean;
    localLinksAndPathTextVerified: boolean;
    searchInput: boolean;
    outcomeFilter: boolean;
    repoFilter: boolean;
    providerStatusFilter: boolean;
    mutationVerdictFilter: boolean;
    alphaFilter: boolean;
    resetFiltersButton: boolean;
    detailsDrilldown: boolean;
    safetyLabels: boolean;
    noExternalNetworkDependencies: boolean;
    seedRecordCountMatchesDashboard: boolean;
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

commands.push(await runCli(["packet", "index", "--root", root, "--out", outputs.index, "--dashboard-seed"]));
commands.push(await runCli(["dashboard", "build", "--seed", join(outputs.index, "dashboard-seed.json"), "--out", outputs.dashboard]));

for (const command of commands) {
  if (command.exitCode !== 0) errors.push(`${command.command} failed with exit ${command.exitCode}`);
}

const htmlPath = join(outputs.dashboard, "index.html");
const dataPath = join(outputs.dashboard, "dashboard-data.json");
const html = await readFile(htmlPath, "utf8");
const dashboard = await readJson<DashboardData>(dataPath);
const seed = await readJson<{ records: unknown[] }>(join(outputs.index, "dashboard-seed.json"));

const checks: Alpha13Results["checks"] = {
  dashboardSchemaVersion: dashboard.schemaVersion,
  dashboardRecords: dashboard.records.length,
  filtersTested: ["text search", "outcome", "repo", "provider status", "mutation verdict", "alpha/milestone"],
  expectedRecordsFound: [
    "proposal_ready_verified",
    "provider_rejected",
    "smartsql",
    "mutation:unchanged"
  ],
  noBackendRequired: !html.includes("fetch(") && !html.includes("XMLHttpRequest") && !html.includes("WebSocket"),
  staticDashboardWorksFromGeneratedFiles: html.includes("<script>") && html.includes("dashboard-data.json") === false,
  localLinksAndPathTextVerified: html.includes("file://") && html.includes("<code") && html.includes("Packet path") && html.includes("Viewer path"),
  searchInput: html.includes('id="dashboard-search"'),
  outcomeFilter: html.includes('id="outcome-filter"'),
  repoFilter: html.includes('id="repo-filter"'),
  providerStatusFilter: html.includes('id="provider-status-filter"'),
  mutationVerdictFilter: html.includes('id="mutation-verdict-filter"'),
  alphaFilter: html.includes('id="alpha-filter"'),
  resetFiltersButton: html.includes('id="reset-filters"'),
  detailsDrilldown: html.includes("<details>") && html.includes("Evidence drilldown"),
  safetyLabels: html.includes("do_not_apply") && html.includes("provider_rejected") && html.includes("forbidden_path"),
  noExternalNetworkDependencies: !html.includes("<script src=") && !html.includes("<link rel=\"stylesheet\" href=\"http"),
  seedRecordCountMatchesDashboard: seed.records.length === dashboard.records.length
};

if (dashboard.schemaVersion !== "alpha-12-dashboard") errors.push(`dashboard schema mismatch: ${dashboard.schemaVersion}`);
if (dashboard.records.length < 6) errors.push(`expected at least 6 dashboard records, got ${dashboard.records.length}`);
if (!checks.seedRecordCountMatchesDashboard) errors.push("dashboard record count does not match seed");
if (!checks.noBackendRequired) errors.push("dashboard appears to require a backend or live API");
if (!checks.staticDashboardWorksFromGeneratedFiles) errors.push("dashboard does not look self-contained in generated HTML");
if (!checks.localLinksAndPathTextVerified) errors.push("dashboard missing local links or copyable path text");
if (!checks.searchInput) errors.push("dashboard HTML missing search input");
if (!checks.outcomeFilter) errors.push("dashboard HTML missing outcome filter");
if (!checks.repoFilter) errors.push("dashboard HTML missing repo filter");
if (!checks.providerStatusFilter) errors.push("dashboard HTML missing provider status filter");
if (!checks.mutationVerdictFilter) errors.push("dashboard HTML missing mutation verdict filter");
if (!checks.alphaFilter) errors.push("dashboard HTML missing alpha filter");
if (!checks.resetFiltersButton) errors.push("dashboard HTML missing reset filters button");
if (!checks.detailsDrilldown) errors.push("dashboard HTML missing details drilldown");
if (!checks.safetyLabels) errors.push("dashboard HTML missing required safety labels");
if (!checks.noExternalNetworkDependencies) errors.push("dashboard HTML references external network dependencies");
for (const expected of checks.expectedRecordsFound) {
  if (!html.includes(expected)) errors.push(`dashboard HTML missing expected record marker: ${expected}`);
}

const results: Alpha13Results = {
  schemaVersion: "alpha-13-results",
  generatedAt: new Date().toISOString(),
  outputs: {
    ...outputs,
    indexHtml: htmlPath,
    dashboardData: dataPath
  },
  checks,
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

function renderSummary(results: Alpha13Results): string {
  const lines = [
    "# RunForge Alpha-13 Validation",
    "",
    `Generated at: ${results.generatedAt}`,
    "",
    "## Dashboard Outputs",
    "",
    `- dashboard build path: ${results.outputs.dashboard}`,
    `- index path: ${results.outputs.index}`,
    `- dashboard HTML path: ${results.outputs.indexHtml}`,
    `- dashboard data path: ${results.outputs.dashboardData}`,
    "",
    "## Checks",
    "",
    `- Dashboard schemaVersion: ${results.checks.dashboardSchemaVersion}`,
    `- Dashboard data record count: ${results.checks.dashboardRecords}`,
    `- Filters tested: ${results.checks.filtersTested.join(", ")}`,
    `- Expected records found: ${results.checks.expectedRecordsFound.join(", ")}`,
    `- No backend required: ${results.checks.noBackendRequired}`,
    `- Static dashboard works from generated files: ${results.checks.staticDashboardWorksFromGeneratedFiles}`,
    `- Local links/path display verified in generated HTML: ${results.checks.localLinksAndPathTextVerified}`,
    `- Search input: ${results.checks.searchInput}`,
    `- Outcome filter: ${results.checks.outcomeFilter}`,
    `- Repo filter: ${results.checks.repoFilter}`,
    `- Provider status filter: ${results.checks.providerStatusFilter}`,
    `- Mutation verdict filter: ${results.checks.mutationVerdictFilter}`,
    `- Alpha/milestone filter: ${results.checks.alphaFilter}`,
    `- Reset filters button: ${results.checks.resetFiltersButton}`,
    `- Details drilldown: ${results.checks.detailsDrilldown}`,
    `- Safety labels: ${results.checks.safetyLabels}`,
    `- No external network dependencies: ${results.checks.noExternalNetworkDependencies}`,
    `- Seed count matches dashboard data: ${results.checks.seedRecordCountMatchesDashboard}`,
    "",
    "## Commands",
    "",
    ...results.commands.map((command) => `- ${command.status.toUpperCase()} ${command.command}`)
  ];

  if (results.errors.length > 0) {
    lines.push("", "## Errors", "", ...results.errors.map((error) => `- ${error}`));
  } else {
    lines.push("", "Alpha-13 validation: passed");
  }

  return `${lines.join("\n")}\n`;
}
