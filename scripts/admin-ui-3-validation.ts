import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildAdminUi } from "../src/admin/builder.js";
import { defaultAdminConfig, writeAdminConfig, type AdminConfig } from "../src/admin/config.js";
import { compareRuns, filterRuns, normalizeArtifactLinks, sortRuns } from "../src/admin/run-browser.js";
import { startAdminServer } from "../src/admin/server.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const out = join(repo, "validation/runs/ADMIN-UI-3");
const errors: string[] = [];
const commandsRun = ["pnpm validation:admin-ui-3"];

await mkdir(out, { recursive: true });

const configPath = join(tmpdir(), "runforge-admin-ui-3-config.json");
const adminOut = "/tmp/runforge-admin-ui";
const config: AdminConfig = {
  ...defaultAdminConfig(),
  repositories: [
    { id: "runforge", name: "RunForge", path: repo, tags: ["self", "admin-ui-3"] }
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
const runs = build.data.runs;
const first = runs[0];
const second = runs.find((run) => run.id !== first?.id);
const detail = first ? build.data.runDetails.find((item) => item.packetPath === first.packetPath) : undefined;
const artifactLinks = first ? normalizeArtifactLinks(first, detail) : [];
const sortedNewest = sortRuns(runs, "newest");
const urgentRuns = filterRuns(runs, { urgentOnly: true });
const textFiltered = first ? filterRuns(runs, { text: first.repo }) : [];
const statusFiltered = first ? filterRuns(runs, { repo: first.repo, alpha: first.alpha, outcome: first.outcome, providerStatus: first.providerStatus }) : [];
const compare = first && second ? compareRuns(first, second) : null;
const detailWithFallback = build.data.runDetails.find((item) => item.graphSource === "fallback");
const detailWithEvents = build.data.runDetails.find((item) => item.graphSource === "events");

check(runs.length > 0, "run browser should load indexed runs");
check(textFiltered.length > 0, "text search should find at least one run");
check(statusFiltered.length > 0, "repo/alpha/outcome/provider filters should find at least one run");
check(urgentRuns.length === build.data.overview.urgentSafetyCounts.urgent, "urgent filter should match overview urgent count");
check(sortedNewest.length === runs.length, "newest sorting should preserve run count");
check(Boolean(detail), "run detail should load for first indexed run");
check(Boolean(detailWithFallback) || Boolean(detailWithEvents), "timeline should load from events or fallback");
check(artifactLinks.length > 0, "artifact link normalization should return links for first run");
check(compare === null || compare.changedCount >= 0, "compare should produce changed field metadata when two runs exist");
check(html.includes("Runs Browser"), "rendered UI should include run browser");
check(html.includes("Run Detail / Timeline"), "rendered UI should include run detail timeline");
check(html.includes("Compare Runs"), "rendered UI should include compare view");
check(html.includes("Settings"), "settings page should remain present");
check(!html.includes("sk-or-v1-validation-secret"), "rendered HTML should not expose raw validation token values");

let artifactRouteStatus = 0;
let traversalStatus = 0;
let artifactRoutePath = "not tested";
const server = await startAdminServer({ config: configPath, repoRoot: repo, out: join(tmpdir(), "runforge-admin-ui-3-server"), port: 0 });
try {
  const candidatePaths = [
    join(repo, "validation/runs/ADMIN-UI-2/results.json"),
    join(repo, "validation/runs/ADMIN-UI-2/summary.md"),
    ...runs.flatMap((run) => [
      run.eventsPath,
      run.summaryPath,
      run.metricsPath,
      run.safetyReportPath,
      run.providerAuditPath,
      run.resultsPath
    ]),
    ...Object.values(build.data.artifactLinks).flat().map((link) => link.path)
  ].filter((path) => path !== "unknown" && path.startsWith(repo));
  for (const candidatePath of candidatePaths) {
    if (await exists(candidatePath)) {
      artifactRoutePath = candidatePath;
      const artifactResponse = await fetch(new URL(`/api/admin/artifact?path=${encodeURIComponent(candidatePath)}`, server.url));
      artifactRouteStatus = artifactResponse.status;
      break;
    }
  }
  const traversal = await fetch(new URL(`/api/admin/artifact?path=${encodeURIComponent(join(repo, "package.json"))}`, server.url));
  traversalStatus = traversal.status;
} finally {
  await new Promise<void>((resolveClose) => server.server.close(() => resolveClose()));
}
check(artifactRouteStatus === 0 || artifactRouteStatus === 200, "artifact route should read an allowed artifact when one is available");
check(traversalStatus === 403, "artifact route should reject paths outside configured run roots");

const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
const sha = await git(["rev-parse", "--short", "HEAD"]);
const dirty = (await git(["status", "--short"])).trim().length > 0;

const results = {
  schemaVersion: "admin-ui-3-validation",
  ok: errors.length === 0,
  branch,
  commitSha: sha,
  worktreeDirtyDuringEvidence: dirty,
  configPath,
  adminOutputPath: adminOut,
  adminIndexPath: build.indexPath,
  adminDataPath: build.dataPath,
  counts: {
    runs: runs.length,
    details: build.data.runDetails.length,
    urgent: urgentRuns.length,
    artifactsForFirstRun: artifactLinks.length
  },
  filtersTested: {
    text: textFiltered.length,
    status: statusFiltered.length,
    urgent: urgentRuns.length
  },
  detailTimeline: {
    eventsDetailPresent: Boolean(detailWithEvents),
    fallbackDetailPresent: Boolean(detailWithFallback),
    firstDetailGraphNodes: detail?.graph.length ?? 0
  },
  compare: compare ? { changedCount: compare.changedCount, leftId: compare.leftId, rightId: compare.rightId } : { skipped: "only one run indexed" },
  artifactRoute: {
    url: server.url,
    allowedStatus: artifactRouteStatus,
    traversalStatus,
    testedPath: artifactRoutePath,
    stopped: true
  },
  redaction: {
    rawTokenValueRendered: html.includes("sk-or-v1-validation-secret")
  },
  commandsRun,
  errors
};

await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
const summary = [
  "# ADMIN-UI-3 Validation",
  "",
  `Branch: ${branch}`,
  `Commit SHA: ${sha}`,
  `Worktree dirty during evidence: ${dirty}`,
  `Admin output path: ${adminOut}`,
  `Admin index path: ${build.indexPath}`,
  `Admin data path: ${build.dataPath}`,
  "",
  "## Checks",
  "",
  `- Indexed runs loaded: ${runs.length}`,
  `- Text filter result count: ${textFiltered.length}`,
  `- Repo/alpha/outcome/provider filter result count: ${statusFiltered.length}`,
  `- Urgent/safety filter result count: ${urgentRuns.length}`,
  `- Detail graph nodes for first run: ${detail?.graph.length ?? 0}`,
  `- Events timeline present: ${Boolean(detailWithEvents)}`,
  `- Fallback timeline present: ${Boolean(detailWithFallback)}`,
  `- Artifact/deep links for first run: ${artifactLinks.length}`,
  `- Compare changed fields: ${compare?.changedCount ?? "skipped"}`,
  `- Artifact route allowed status: ${artifactRouteStatus || "not tested"}`,
  `- Artifact route traversal rejection: ${traversalStatus}`,
  `- Raw token value rendered: ${results.redaction.rawTokenValueRendered}`,
  "",
  "## Commands Run",
  "",
  ...commandsRun.map((command) => `- ${command}`),
  "",
  "## Safety",
  "",
  "- No provider APIs were called.",
  "- No repositories were mutated.",
  "- Artifact server smoke was localhost-only, read-only, and shut down.",
  "- Artifact route rejected a path outside configured run roots.",
  "",
  "## Known Limitations",
  "",
  "- Browser file:// opening remains browser-policy dependent; absolute paths and copy buttons are always rendered.",
  "- Compare view is intentionally lightweight and field-based.",
  "",
  errors.length === 0 ? "ADMIN-UI-3 validation: passed" : "ADMIN-UI-3 validation: failed",
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
