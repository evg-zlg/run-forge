import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { renderActionPlanReport, writeActionPlanReport } from "../src/admin/action-plan-report.js";
import { buildAdminUi } from "../src/admin/builder.js";
import { defaultAdminConfig, writeAdminConfig, type AdminConfig } from "../src/admin/config.js";
import { filterRuns } from "../src/admin/run-browser.js";
import { startAdminServer } from "../src/admin/server.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const out = join(repo, "validation/runs/ADMIN-UI-4");
const errors: string[] = [];
const commandsRun = ["pnpm validation:admin-ui-4"];

await mkdir(out, { recursive: true });

const configPath = join(tmpdir(), "runforge-admin-ui-4-config.json");
const adminOut = "/tmp/runforge-admin-ui";
const actionPlanPath = "/tmp/runforge-action-plan.md";
const config: AdminConfig = {
  ...defaultAdminConfig(),
  repositories: [
    { id: "runforge", name: "RunForge", path: repo, tags: ["self", "admin-ui-4"] }
  ],
  providers: [
    { id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: "env:OPENROUTER_API_KEY", defaultModel: null },
    { id: "codex-cli", type: "cli", enabled: false, command: "codex" }
  ],
  runs: {
    defaultRoots: ["validation/runs"]
  }
};
await writeAdminConfig(configPath, config);

const build = await buildAdminUi({ config: configPath, out: adminOut, repoRoot: repo });
const html = await readFile(build.indexPath, "utf8");
const actionPlan = renderActionPlanReport(build.data, config);
await writeActionPlanReport({ out: actionPlanPath, data: build.data, config });

const allActions = Object.values(build.data.actionPreviews).flat();
const blockedActions = allActions.filter((action) => action.mode === "blocked");
const mutatingActions = allActions.filter((action) => action.mode === "mutating");
const blockedCopyButtons = blockedActions.filter((action) => Boolean(action.command)).length;
const mutatingWithoutWarning = mutatingActions.filter((action) => !(action.warnings ?? []).some((warning) => warning.includes("Admin UI never executes")));
const blockedRuns = filterRuns(build.data.runs, { hasBlockedAction: true });
const mutatingRuns = filterRuns(build.data.runs, { hasMutatingPreview: true });
const safeRuns = filterRuns(build.data.runs, { hasSafeAction: true });
const cautionRuns = filterRuns(build.data.runs, { hasCautionAction: true });
const runsRequiringCaution = build.data.actionQueue.runsRequiringCaution;
const noActionRuns = filterRuns(build.data.runs, { hasNoRecommendedAction: true });
const tokenPatterns = [
  /sk-or-v1-[A-Za-z0-9._-]{8,}/i,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /OPENROUTER_API_KEY=[^\s\]]+/i
];

check(build.data.runs.length > 0, "admin data should include indexed runs");
check(allActions.length > 0, "action previews should be generated");
check(build.data.actionQueue.runsWithMutatingPreviews === mutatingRuns.length, "mutating queue count should match filter count");
check(build.data.actionQueue.runsBlockedBySafety === blockedRuns.length, "blocked queue count should match filter count");
check(blockedCopyButtons === 0, "blocked actions should not expose copyable commands");
check(mutatingWithoutWarning.length === 0, "mutating actions should carry manual-only UI warning");
check(html.includes("Operator Queue"), "overview should render Operator Queue");
check(html.includes("Action Previews"), "run detail should render Action Previews");
check(html.includes("data-quick=\"action_blocked\""), "runs browser should render blocked action filter");
check(html.includes("data-quick=\"action_mutating\""), "runs browser should render mutating action filter");
check(actionPlan.includes("Generated:"), "action plan should include generated timestamp");
check(actionPlan.includes("Config path:"), "action plan should include config path");
check(actionPlan.includes("Run roots:"), "action plan should include run roots");
check(actionPlan.includes("Runs inspected:"), "action plan should include inspected run count");
check(actionPlan.includes("Top Recommended Actions"), "action plan should include recommended actions");
check(actionPlan.includes("Known Limitations"), "action plan should include limitations");
check(!tokenPatterns.some((pattern) => pattern.test(html)), "rendered HTML should not expose raw token-like values");
check(!tokenPatterns.some((pattern) => pattern.test(JSON.stringify(build.data))), "admin data should not expose raw token-like values");
check(!tokenPatterns.some((pattern) => pattern.test(actionPlan)), "action plan should not expose raw token-like values");

let statusProviderCalls: boolean | null = null;
let statusRepoMutation: boolean | null = null;
const server = await startAdminServer({ config: configPath, repoRoot: repo, out: join(tmpdir(), "runforge-admin-ui-4-server"), port: 0 });
try {
  const status = await fetch(new URL("/api/admin/status", server.url)).then((response) => response.json()) as { providerCalls: boolean; repoMutation: boolean };
  statusProviderCalls = status.providerCalls;
  statusRepoMutation = status.repoMutation;
} finally {
  await new Promise<void>((resolveClose) => server.server.close(() => resolveClose()));
}
check(statusProviderCalls === false, "admin server status should report no provider calls");
check(statusRepoMutation === false, "admin server status should report no repo mutation");

const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
const sha = await git(["rev-parse", "--short", "HEAD"]);
const dirty = (await git(["status", "--short"])).trim().length > 0;

const countsByMode = countBy(allActions.map((action) => action.mode));
const countsBySafety = countBy(allActions.map((action) => action.safety));
const results = {
  schemaVersion: "admin-ui-4-validation",
  ok: errors.length === 0,
  branch,
  commitSha: sha,
  worktreeDirtyDuringEvidence: dirty,
  configPath,
  adminOutputPath: adminOut,
  adminIndexPath: build.indexPath,
  adminDataPath: build.dataPath,
  actionPlanPath,
  counts: {
    runs: build.data.runs.length,
    actionPreviews: allActions.length,
    blockedActions: blockedActions.length,
    mutatingActions: mutatingActions.length,
    blockedRuns: blockedRuns.length,
    mutatingRuns: mutatingRuns.length,
    safeRuns: safeRuns.length,
    cautionRuns: cautionRuns.length,
    runsRequiringCaution,
    noRecommendedActionRuns: noActionRuns.length
  },
  countsByMode,
  countsBySafety,
  queue: build.data.actionQueue,
  safetyChecks: {
    blockedCopyButtons,
    mutatingManualOnlyWarnings: mutatingWithoutWarning.length === 0,
    renderedHtmlTokenLeak: tokenPatterns.some((pattern) => pattern.test(html)),
    adminDataTokenLeak: tokenPatterns.some((pattern) => pattern.test(JSON.stringify(build.data))),
    actionPlanTokenLeak: tokenPatterns.some((pattern) => pattern.test(actionPlan)),
    providerCalls: statusProviderCalls,
    repoMutation: statusRepoMutation
  },
  visualReview: {
    path: "validation/runs/ADMIN-UI-4/visual-review.md",
    clipboardFallbackNote: "Browser clipboard APIs may be blocked; copy controls fall back to selected feedback."
  },
  commandsRun,
  errors
};

await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
const summary = [
  "# ADMIN-UI-4 Validation",
  "",
  `Branch: ${branch}`,
  `Commit SHA: ${sha}`,
  `Worktree dirty during evidence: ${dirty}`,
  `Admin output path: ${adminOut}`,
  `Admin index path: ${build.indexPath}`,
  `Admin data path: ${build.dataPath}`,
  `Action plan path: ${actionPlanPath}`,
  `Runs inspected: ${build.data.runs.length}`,
  `Action previews generated: ${allActions.length}`,
  "",
  "## Counts",
  "",
  `- By mode: ${JSON.stringify(countsByMode)}`,
  `- By safety: ${JSON.stringify(countsBySafety)}`,
  `- Runs with safe actions: ${safeRuns.length}`,
  `- Runs requiring caution: ${runsRequiringCaution}`,
  `- Runs blocked by safety: ${blockedRuns.length}`,
  `- Runs with mutating previews: ${mutatingRuns.length}`,
  `- Runs with no recommended action: ${noActionRuns.length}`,
  "",
  "## Safety Checks",
  "",
  `- Blocked action copy-command buttons: ${blockedCopyButtons}`,
  `- Mutating previews manual-only warnings present: ${mutatingWithoutWarning.length === 0}`,
  `- Rendered HTML token leak: ${results.safetyChecks.renderedHtmlTokenLeak}`,
  `- Admin data token leak: ${results.safetyChecks.adminDataTokenLeak}`,
  `- Action plan token leak: ${results.safetyChecks.actionPlanTokenLeak}`,
  `- Server provider calls: ${statusProviderCalls}`,
  `- Server repo mutation: ${statusRepoMutation}`,
  "",
  "## Visual Review",
  "",
  "- Visual browser review is recorded in `validation/runs/ADMIN-UI-4/visual-review.md`.",
  "- Clipboard fallback note: browser clipboard APIs may be blocked; copy controls fall back to selected feedback.",
  "",
  "## Commands Run",
  "",
  ...commandsRun.map((command) => `- ${command}`),
  "",
  "## Known Limitations",
  "",
  "- ADMIN-UI-4 is preview/copy/report only; it does not execute commands, call providers, mutate repositories, apply patches, deploy, or merge.",
  "- Mutating previews are manual terminal checklists that require explicit operator approval outside the Admin UI.",
  "",
  errors.length === 0 ? "ADMIN-UI-4 validation: passed" : "ADMIN-UI-4 validation: failed",
  ...errors.map((error) => `- ${error}`)
].join("\n") + "\n";
await writeFile(join(out, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

async function git(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd: repo });
    return String(result.stdout).trim();
  } catch {
    return "unknown";
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
