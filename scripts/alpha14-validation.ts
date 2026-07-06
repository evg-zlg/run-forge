import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-14");
const root = join(repo, "validation/runs");

const outputs = {
  index: "/tmp/runforge-alpha14-index",
  dashboard: "/tmp/runforge-alpha14-dashboard"
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
    byScenario: Record<string, number>;
    byAlpha: Record<string, number>;
    byAlphaComparison: unknown[];
    verifiedProposals: number;
    rejectedProviderProposals: number;
    doNotApplyOrUnsafe: number;
    unchangedMutationVerdicts: number;
    reposCovered: number;
    latestAlpha: string;
    latestVerifiedProposal: string;
    latestRejection: string;
  };
  records: unknown[];
}

interface Alpha14Results {
  schemaVersion: "alpha-14-results";
  generatedAt: string;
  outputs: typeof outputs & {
    indexHtml: string;
    dashboardData: string;
  };
  checks: {
    dashboardSchemaVersion: string;
    dashboardRecords: number;
    dashboardOutputPath: string;
    filtersRestoredFromHashOrQuery: boolean;
    filterStateUpdatesUrl: boolean;
    resetClearsUrlAndFilters: boolean;
    copyCurrentViewAffordance: boolean;
    groupedRepoCounts: boolean;
    groupedScenarioCounts: boolean;
    groupedOutcomeCounts: boolean;
    groupedAlphaCounts: boolean;
    alphaComparisonChecked: boolean;
    derivedCountersChecked: boolean;
    quickVerifiedFilter: boolean;
    quickUnsafeFilter: boolean;
    sortableRecordsTable: boolean;
    emptyState: boolean;
    noBackendRequired: boolean;
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

const checks: Alpha14Results["checks"] = {
  dashboardSchemaVersion: dashboard.schemaVersion,
  dashboardRecords: dashboard.records.length,
  dashboardOutputPath: outputs.dashboard,
  filtersRestoredFromHashOrQuery: html.includes("readStateFromHash") && html.includes("URLSearchParams") && html.includes("window.location.hash"),
  filterStateUpdatesUrl: html.includes("updateCurrentView") && html.includes("history.pushState"),
  resetClearsUrlAndFilters: html.includes('id="reset-filters"') && html.includes('quickFilter = ""') && html.includes('scenarioFilter = ""'),
  copyCurrentViewAffordance: html.includes('id="copy-current-view"') && html.includes('id="current-view-url"'),
  groupedRepoCounts: html.includes("By repo") && html.includes('data-filter-key="repo"') && Object.keys(dashboard.summary.byRepo).length > 0,
  groupedScenarioCounts: html.includes("By scenario") && html.includes('data-filter-key="scenario"') && Object.keys(dashboard.summary.byScenario).length > 0,
  groupedOutcomeCounts: html.includes("By outcome") && html.includes('data-filter-key="outcome"') && Object.keys(dashboard.summary.byOutcome).length > 0,
  groupedAlphaCounts: html.includes("By alpha / milestone") && html.includes('data-filter-key="alpha"') && Object.keys(dashboard.summary.byAlpha).length > 0,
  alphaComparisonChecked: html.includes("Alpha comparison") && dashboard.summary.byAlphaComparison.length > 0,
  derivedCountersChecked: dashboard.summary.verifiedProposals >= 0 && dashboard.summary.rejectedProviderProposals >= 0 && dashboard.summary.doNotApplyOrUnsafe >= 0 && dashboard.summary.unchangedMutationVerdicts >= 0 && dashboard.summary.reposCovered > 0 && dashboard.summary.latestAlpha !== "unknown" && typeof dashboard.summary.latestVerifiedProposal === "string" && typeof dashboard.summary.latestRejection === "string",
  quickVerifiedFilter: html.includes('data-quick-filter="verified"') && html.includes("proposal_ready_verified"),
  quickUnsafeFilter: html.includes('data-quick-filter="unsafe"') && html.includes("do_not_apply"),
  sortableRecordsTable: html.includes('id="records-table"') && html.includes('data-sort="alpha"') && html.includes("sortRows"),
  emptyState: html.includes('id="empty-state"') && html.includes("No records match the active filters"),
  noBackendRequired: !html.includes("fetch(") && !html.includes("XMLHttpRequest") && !html.includes("WebSocket"),
  noExternalNetworkDependencies: !html.includes("<script src=") && !html.includes("<link rel=\"stylesheet\" href=\"http") && !html.includes("https://") && !html.includes("http://"),
  seedRecordCountMatchesDashboard: seed.records.length === dashboard.records.length
};

if (dashboard.schemaVersion !== "alpha-12-dashboard") errors.push(`dashboard schema mismatch: ${dashboard.schemaVersion}`);
if (dashboard.records.length < 6) errors.push(`expected at least 6 dashboard records, got ${dashboard.records.length}`);
if (!checks.seedRecordCountMatchesDashboard) errors.push("dashboard record count does not match seed");
if (!checks.filtersRestoredFromHashOrQuery) errors.push("dashboard missing hash/query restore logic");
if (!checks.filterStateUpdatesUrl) errors.push("dashboard missing URL update logic");
if (!checks.resetClearsUrlAndFilters) errors.push("dashboard reset does not clear URL-backed filter state");
if (!checks.copyCurrentViewAffordance) errors.push("dashboard missing copy current view affordance");
if (!checks.groupedRepoCounts) errors.push("dashboard missing grouped repo counts");
if (!checks.groupedScenarioCounts) errors.push("dashboard missing grouped scenario counts");
if (!checks.groupedOutcomeCounts) errors.push("dashboard missing grouped outcome counts");
if (!checks.groupedAlphaCounts) errors.push("dashboard missing grouped alpha counts");
if (!checks.alphaComparisonChecked) errors.push("dashboard missing alpha comparison");
if (!checks.derivedCountersChecked) errors.push("dashboard missing derived counters");
if (!checks.quickVerifiedFilter) errors.push("dashboard missing verified proposal quick filter");
if (!checks.quickUnsafeFilter) errors.push("dashboard missing unsafe/do_not_apply quick filter");
if (!checks.sortableRecordsTable) errors.push("dashboard missing sortable records table");
if (!checks.emptyState) errors.push("dashboard missing empty state");
if (!checks.noBackendRequired) errors.push("dashboard appears to require a backend or live API");
if (!checks.noExternalNetworkDependencies) errors.push("dashboard HTML references external network dependencies");

const results: Alpha14Results = {
  schemaVersion: "alpha-14-results",
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

function renderSummary(results: Alpha14Results): string {
  const lines = [
    "# RunForge Alpha-14 Validation",
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
    `- Filters restored from hash/query: ${results.checks.filtersRestoredFromHashOrQuery}`,
    `- Filter changes update URL state: ${results.checks.filterStateUpdatesUrl}`,
    `- Reset clears URL/filter state: ${results.checks.resetClearsUrlAndFilters}`,
    `- Copy current view affordance: ${results.checks.copyCurrentViewAffordance}`,
    `- Grouped repo counts checked: ${results.checks.groupedRepoCounts}`,
    `- Grouped scenario counts checked: ${results.checks.groupedScenarioCounts}`,
    `- Grouped outcome counts checked: ${results.checks.groupedOutcomeCounts}`,
    `- Grouped alpha counts checked: ${results.checks.groupedAlphaCounts}`,
    `- Alpha comparison checked: ${results.checks.alphaComparisonChecked}`,
    `- Derived counters checked: ${results.checks.derivedCountersChecked}`,
    `- Quick verified filter checked: ${results.checks.quickVerifiedFilter}`,
    `- Quick unsafe/do_not_apply filter checked: ${results.checks.quickUnsafeFilter}`,
    `- Sortable records table: ${results.checks.sortableRecordsTable}`,
    `- Empty state: ${results.checks.emptyState}`,
    `- No backend required: ${results.checks.noBackendRequired}`,
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
    lines.push("", "Alpha-14 validation: passed");
  }

  return `${lines.join("\n")}\n`;
}
