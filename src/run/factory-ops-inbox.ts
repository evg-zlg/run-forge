import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type FactoryOpsInboxOptions = { repos?: string[]; projectSet?: string; out: string; staleDays?: number; now?: Date };
type Check = { __typename?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string };
type Pull = { number: number; title: string; url: string; isDraft: boolean; headRefName: string; updatedAt: string; mergeStateStatus: string; state: "OPEN" | "CLOSED" | "MERGED"; statusCheckRollup?: Check[] };
type PullHistory = Pick<Pull, "headRefName" | "state">;
type Item = { project: string; kind: "pr" | "branch" | "patch-package"; reference: string; status: string; ci_status: string; risk: string; recommended_owner_action: string; why: string; evidence: string };
type ProjectResult = { project: string; path: string; exists: boolean; git: boolean; mode: string; head_before?: string; head_after?: string; branch?: string; status_before?: string; status_after?: string; remote?: string; error?: string; items: Item[] };

const KNOWN = ["/Users/evgeny/Documents/projects/factory", "/Users/evgeny/Documents/projects/upravdom", "/Users/evgeny/Documents/autokitaec", "/Users/evgeny/Documents/projects/smartsql"];
const RUNFORGE_REF = /^(runforge\/|codex\/runforge|runforge-)/i;

export async function runFactoryOpsInbox(options: FactoryOpsInboxOptions) {
  const staleDays = options.staleDays ?? 14;
  if (!Number.isFinite(staleDays) || staleDays < 1) throw new Error("--stale-days must be a positive number.");
  const repos = options.repos?.length ? options.repos : options.projectSet === "all-known" ? KNOWN : [];
  if (!repos.length) throw new Error("Repeat --repo <path>, or use --project-set all-known.");
  if (options.projectSet && options.projectSet !== "all-known") throw new Error(`Unknown project set '${options.projectSet}'.`);
  const out = resolve(options.out); await mkdir(join(out, "projects"), { recursive: true });
  const now = options.now ?? new Date(); const projects: ProjectResult[] = [];
  for (const input of repos) projects.push(await inspectProject(resolve(input), out, now, staleDays));
  const items = projects.flatMap((project) => project.items);
  const prs = items.filter((item) => item.kind === "pr");
  const branches = items.filter((item) => item.kind === "branch");
  const packages = items.filter((item) => item.kind === "patch-package");
  const decisions = items.filter((item) => ["needs-owner-decision", "needs-fix", "hold"].includes(item.recommended_owner_action));
  const backlogSize = prs.length; const backlogHigh = backlogSize > 5;
  const recommendedNextRun = backlogHigh ? "hold-new-target-work; process owner action queue" : "run autopilot on one safe non-SmartSQL project";
  const targetUnchanged = projects.filter((p) => p.git).every((p) => p.head_before === p.head_after && p.status_before === p.status_after);
  const state = { projects_inspected: projects.map((p) => ({ project: p.project, path: p.path, exists: p.exists, git: p.git, mode: p.mode, head_before: p.head_before, head_after: p.head_after, status_before: p.status_before, status_after: p.status_after })), open_runforge_prs: prs.map(compact), open_runforge_branches: branches.map(compact), patch_packages: packages.map(compact), owner_decision_items: decisions.map(compact), backlog_size: backlogSize, backlog_high: backlogHigh, recommended_next_run: recommendedNextRun };
  await writeJson(join(out, "ops-state.json"), state);
  await writeJson(join(out, "results.json"), { status: targetUnchanged ? "completed" : "unsafe", projects: projects.length, items: items.length, open_runforge_prs: prs.length, patch_packages: packages.length, backlog_size: backlogSize, backlog_high: backlogHigh, new_target_prs_created: 0, target_unchanged: targetUnchanged });
  await writeFile(join(out, "owner-inbox.md"), renderInbox(items, backlogSize, backlogHigh));
  await writeFile(join(out, "backlog-report.md"), `# Backlog report\n\n- Open RunForge-created target PRs: **${backlogSize}**\n- High-backlog threshold: more than 5\n- Policy result: **${backlogHigh ? "STOP — do not create new target PRs" : "capacity available for one safe batch"}**\n- Patch packages: ${packages.length}\n- Owner-decision items: ${decisions.length}\n`);
  await writeFile(join(out, "project-status-report.md"), renderProjects(projects));
  await writeFile(join(out, "summary.md"), `# Multi-project factory owner inbox\n\nInspected ${projects.length} project paths and found ${prs.length} open RunForge-created target PRs, ${branches.length} unpaired RunForge branches, and ${packages.length} patch packages. Backlog is **${backlogHigh ? "high" : "low"}**; ${backlogHigh ? "no new target work was run" : "one safe project may be considered for the next batch"}. Target Git HEADs and worktree status were ${targetUnchanged ? "unchanged" : "NOT unchanged"}.\n\nDaily-loop verdict: **${targetUnchanged ? "usable" : "unsafe"}**.\n`);
  await writeFile(join(out, "execution-log.md"), `# Execution log\n\n- ${now.toISOString()} Read-only inspection of ${projects.length} paths.\n- GitHub metadata: read-only PR/check collection; failures recorded per project.\n- Backlog policy: ${backlogHigh ? "high; autopilot skipped" : "low; no automatic execution performed by inbox command"}.\n- Mutations: artifacts in RunForge only; target branches, PRs, worktrees, DB, production, secrets, deploys, and migrations untouched.\n`);
  await writeJson(join(out, "packet-validation.json"), { valid: targetUnchanged, required_top_level_artifacts: ["summary.md", "results.json", "owner-inbox.md", "ops-state.json", "backlog-report.md", "project-status-report.md", "execution-log.md", "packet-validation.json"], safety: { target_unchanged: targetUnchanged, target_prs_created: 0, target_main_mutation: false, provider_calls: false, db_prod_secrets_deploy_migrations: false }, missing_projects: projects.filter((p) => !p.git).map((p) => ({ path: p.path, error: p.error })) });
  return { out, projectsInspected: projects.length, backlogSize, backlogHigh, prs: prs.length, branches: branches.length, patchPackages: packages.length, newTargetPrsCreated: 0, targetUnchanged, recommendedNextRun };
}

async function inspectProject(path: string, out: string, now: Date, staleDays: number): Promise<ProjectResult> {
  const project = keyFor(path); const dir = join(out, "projects", project); await mkdir(dir, { recursive: true });
  const exists = await access(path).then(() => true).catch(() => false);
  const gitRepo = exists && safeGit(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const mode = /smartsql/i.test(path) ? "read-only-triage" : /autokitaec/i.test(path) ? "discovery/triage-only" : "read-only-triage";
  if (!gitRepo) {
    const result = { project, path, exists, git: false, mode, error: exists ? "path exists but is not a Git worktree" : "path not found", items: [] };
    await writeFile(join(dir, "status.md"), `# ${project}\n\n- Path: \`${path}\`\n- Status: ${result.error}\n- Mode: ${mode}\n`); await writeJson(join(dir, "results.json"), result); return result;
  }
  const before = snapshot(path); const remoteUrl = safeGit(path, ["remote", "get-url", "origin"]); const remote = normalizeRemote(remoteUrl);
  let pulls: Pull[] = []; let history: PullHistory[] = []; let historyAvailable = !remote; let error: string | undefined;
  if (remote) {
    try { history = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", remote, "--state", "all", "--limit", "1000", "--json", "headRefName,state"], { encoding: "utf8", timeout: 30_000 })); historyAvailable = true; }
    catch (caught) { error = `GitHub PR history unavailable: ${message(caught)}`; }
    try { pulls = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", remote, "--state", "open", "--limit", "100", "--json", "number,title,url,isDraft,headRefName,updatedAt,mergeStateStatus,state,statusCheckRollup"], { encoding: "utf8", timeout: 30_000 })); }
    catch (caught) { error = [error, `GitHub open-PR metadata unavailable: ${message(caught)}`].filter(Boolean).join("; "); }
  }
  const runforgePulls = pulls.filter((pull) => RUNFORGE_REF.test(pull.headRefName));
  const prBranches = new Set((historyAvailable ? history : runforgePulls).filter((pull) => RUNFORGE_REF.test(pull.headRefName)).map((pull) => pull.headRefName));
  const items = runforgePulls.filter((pull) => pull.state === "OPEN").map((pull) => classifyPull(project, pull, now, staleDays));
  const branchNames = historyAvailable ? liveRunforgeBranches(path).filter((branch) => !prBranches.has(branch)) : [];
  for (const branch of [...new Set(branchNames)]) items.push({ project, kind: "branch", reference: branch, status: "needs owner decision", ci_status: "not-applicable", risk: "unknown", recommended_owner_action: "needs-owner-decision", why: "RunForge branch has no matching PR in the collected GitHub history.", evidence: `${path}#${branch}` });
  for (const packagePath of await findPatchPackages(path)) items.push({ project, kind: "patch-package", reference: packagePath, status: "patch-package-only", ci_status: "not-applicable", risk: "review-required", recommended_owner_action: "needs-owner-decision", why: "Patch package exists without an open RunForge PR association.", evidence: packagePath });
  const after = snapshot(path); const result: ProjectResult = { project, path, exists: true, git: true, mode, head_before: before.head, head_after: after.head, branch: before.branch, status_before: before.status, status_after: after.status, remote, error, items };
  await writeFile(join(dir, "status.md"), renderProject(result)); await writeJson(join(dir, "results.json"), result); return result;
}

function classifyPull(project: string, pull: Pull, now: Date, staleDays: number): Item {
  const checks = pull.statusCheckRollup ?? []; const failed = checks.some((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion ?? c.state ?? ""));
  const pending = checks.some((c) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(c.status ?? c.state ?? ""));
  const green = checks.length > 0 && !failed && !pending && checks.every((c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? c.state ?? ""));
  const stale = now.getTime() - new Date(pull.updatedAt).getTime() > staleDays * 86_400_000;
  const ci = failed ? "failed" : pending ? "pending" : green ? "green" : "no-checks";
  let status = stale ? "stale" : failed ? "failed CI" : pending ? "pending CI" : green ? "green owner-ready" : "needs owner decision";
  let action = stale ? "review-and-close" : failed ? "needs-fix" : pending ? "keep-draft" : green ? "review-and-merge" : "needs-owner-decision";
  let why = stale ? `No update within ${staleDays} days.` : failed ? "At least one reported check failed." : pending ? "At least one reported check is still pending." : green ? "All reported checks are green." : "No CI checks were reported; owner must decide whether local evidence is sufficient.";
  if (!pull.isDraft && action === "keep-draft") { action = "hold"; why += " The PR is not a draft."; }
  return { project, kind: "pr", reference: `PR #${pull.number}: ${pull.title}`, status, ci_status: ci, risk: pull.mergeStateStatus === "CLEAN" ? "bounded" : `merge-${pull.mergeStateStatus.toLowerCase()}`, recommended_owner_action: action, why, evidence: pull.url };
}

async function findPatchPackages(repo: string): Promise<string[]> {
  const roots = [join(repo, "validation", "runs"), join(repo, "artifacts", "runs")]; const found: string[] = [];
  for (const root of roots) for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) if (entry.isFile() && entry.name === "manifest.json" && basename(entry.parentPath) === "patch-package") found.push(join(entry.parentPath, entry.name));
  return found;
}

function snapshot(repo: string) { return { head: safeGit(repo, ["rev-parse", "HEAD"]), branch: safeGit(repo, ["branch", "--show-current"]) || "DETACHED", status: safeGit(repo, ["status", "--porcelain=v1"]) }; }
function liveRunforgeBranches(repo: string): string[] {
  const local = safeGit(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const remote = safeGit(repo, ["ls-remote", "--heads", "origin", "refs/heads/runforge/*", "refs/heads/codex/runforge*", "refs/heads/runforge-*"])
    .split("\n").map((line) => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, "") ?? "").join("\n");
  return [...new Set(`${local}\n${remote}`.split("\n").filter((branch) => RUNFORGE_REF.test(branch)))];
}
function safeGit(repo: string, args: string[]) { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return ""; } }
function normalizeRemote(value: string) { const match = value.match(/(?:github(?:-[^:/]+)?(?:\.com)?)[:/]([^/]+\/[^/.]+)(?:\.git)?$/i); return match?.[1]; }
function keyFor(path: string) { return basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "project"; }
function compact(item: Item) { return { project: item.project, reference: item.reference, status: item.status, ci_status: item.ci_status, recommended_owner_action: item.recommended_owner_action, evidence: item.evidence }; }
function message(error: unknown) { return error instanceof Error ? error.message.split("\n")[0] : String(error); }
async function writeJson(path: string, value: unknown) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
function renderInbox(items: Item[], backlog: number, high: boolean) { const rows = items.length ? items.map((x) => `| ${x.project} | ${x.reference.replaceAll("|", "\\|")} | ${x.status} | ${x.ci_status} | ${x.risk} | ${x.recommended_owner_action} | ${x.why.replaceAll("|", "\\|")} | ${x.evidence} |`).join("\n") : "| — | — | — | — | — | safe-to-ignore | No RunForge items found. | — |"; return `# Multi-project owner inbox\n\nBacklog: **${backlog}** open RunForge-created target PRs (${high ? "high — new target work is stopped" : "below stop threshold"}).\n\n| Project | PR / branch / patch package | Status | CI status | Risk | Recommended owner action | Why | Evidence |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n## Recommended action queue\n\n${items.sort(actionRank).map((x, i) => `${i + 1}. **${x.recommended_owner_action}** — ${x.project}: ${x.reference} (${x.evidence})`).join("\n") || "1. **run-next-batch** — No owner backlog was found."}\n`; }
function actionRank(a: Item, b: Item) { const rank: Record<string, number> = { "needs-fix": 0, "needs-owner-decision": 1, hold: 2, "review-and-merge": 3, "keep-draft": 4, "review-and-close": 5, "safe-to-ignore": 6 }; return (rank[a.recommended_owner_action] ?? 9) - (rank[b.recommended_owner_action] ?? 9); }
function renderProjects(projects: ProjectResult[]) { return `# Project status report\n\n${projects.map(renderProject).join("\n")}`; }
function renderProject(p: ProjectResult) { return `## ${p.project}\n\n- Path: \`${p.path}\`\n- Available Git worktree: ${p.git}\n- Mode: ${p.mode}\n- Branch: ${p.branch ?? "n/a"}\n- HEAD before/after: ${p.head_before ?? "n/a"} / ${p.head_after ?? "n/a"}\n- Worktree status unchanged: ${p.status_before === p.status_after}\n- RunForge items: ${p.items.length}\n${p.error ? `- Note: ${p.error}\n` : ""}`; }
