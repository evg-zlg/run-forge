import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverProject } from "./project-discovery.js";

type Project = { path: string; risk: string; default_profile: string };
type Profile = { publication_permission: string; allowed_actions?: string[]; allowed_file_patterns?: string[]; forbidden_file_patterns?: string[] };
export type FactoryOpsOptions = { project?: string; repo?: string; profile?: string; batchSize: number; out: string; registry?: string; profiles?: string; cache?: string; autopilot?: boolean };
type Candidate = { id: string; source: string; title: string; risk: "low" | "medium" | "high"; file?: string; line?: number; duplicate: boolean; recommended_action: string; evidence: string };
type Outcome = { candidate_id: string; outcome: "patch_package_created" | "owner_decision_needed" | "rejected_with_evidence" | "skip_duplicate"; reason: string; patch_package?: string };
type OpsState = { projects?: string[]; project_states?: Record<string, unknown>; candidates_evaluated?: string[]; candidates_executed?: string[]; draft_prs_created?: string[]; patch_packages_created?: string[]; owner_decisions_needed?: string[] };

export async function runFactoryOps(options: FactoryOpsOptions) {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 20) throw new Error("--batch-size must be an integer from 1 to 20.");
  const registryPath = resolve(options.registry ?? "config/projects.json");
  const profilesPath = resolve(options.profiles ?? "config/authority-profiles.json");
  const registry = await optionalJson<Record<string, Project>>(registryPath) ?? {};
  const profiles = await json<Record<string, Profile>>(profilesPath);
  const registered = options.project ? registry[options.project] : undefined;
  const repoInput = options.repo ?? registered?.path ?? (options.project?.includes("/") ? options.project : undefined);
  if (!repoInput) throw new Error("Provide --repo <path>, or a cached --project name.");
  const project = registered ?? { path: resolve(repoInput), risk: "discovered", default_profile: "auto-low-risk" };
  await access(project.path);
  const before = snapshot(project.path);
  if (before.status) throw new Error("Target repository must be clean; autopilot never edits a dirty source worktree.");
  const discovered = await discoverProject(project.path);
  const requestedProfile = options.profile ?? project.default_profile;
  const profileKey = requestedProfile === "auto-low-risk" ? discovered.recommended_authority_profile : requestedProfile;
  const profile = profiles[profileKey];
  if (!profile) throw new Error(`Unknown authority profile '${profileKey}'.`);
  const out = resolve(options.out);
  const projectKey = registered && options.project ? options.project : discovered.project_key;
  const projectOut = join(out, "projects", projectKey);
  await mkdir(projectOut, { recursive: true });
  const previous = await optionalJson<OpsState>(join(out, "ops-state.json")) ?? {};
  const seen = (previous.candidates_evaluated ?? []).filter((id) => id.startsWith(`${projectKey}:`)).map((id) => id.slice(projectKey.length + 1));
  const packaged = await existingPackages(projectOut);
  const branchRefs = git(project.path, ["branch", "--all", "--format=%(refname:short)"]).split("\n").filter((x) => /runforge|codex\//i.test(x));
  const candidates = await discover(project.path, seen, packaged);
  const selected = candidates.filter((item) => !item.duplicate).slice(0, options.batchSize);
  const outcomes: Outcome[] = [];
  for (const item of candidates.filter((candidate) => candidate.duplicate)) outcomes.push({ candidate_id: item.id, outcome: "skip_duplicate", reason: "Candidate is present in prior ops state or an existing patch package." });
  for (const item of selected) outcomes.push(await executeCandidate(project.path, projectOut, item, profile, Boolean(options.autopilot)));
  const after = snapshot(project.path);
  if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed during factory ops run.");

  const ids = candidates.map((item) => `${projectKey}:${item.id}`);
  const executed = outcomes.filter((x) => x.outcome === "patch_package_created").map((x) => `${projectKey}:${x.candidate_id}`);
  const decisions = outcomes.filter((x) => x.outcome === "owner_decision_needed").map((x) => `${projectKey}:${x.candidate_id}`);
  const packages = outcomes.flatMap((x) => x.patch_package ? [x.patch_package] : []);
  const nextCommand = `corepack pnpm dev factory ops run --repo ${shellDisplay(project.path)} --profile auto-low-risk --batch-size ${options.batchSize} --autopilot --out ${shellDisplay(options.out)}`;
  const state = {
    projects: [...new Set([...(previous.projects ?? []), projectKey])],
    project_states: { ...(previous.project_states ?? {}), [projectKey]: { main_head_before: before.head, main_head_after: after.head, status_before: before.status, status_after: after.status, runforge_branch_refs_detected: branchRefs } },
    candidates_evaluated: [...new Set([...(previous.candidates_evaluated ?? []), ...ids])],
    candidates_executed: [...new Set([...(previous.candidates_executed ?? []), ...executed])], draft_prs_created: previous.draft_prs_created ?? [],
    patch_packages_created: [...new Set([...(previous.patch_packages_created ?? []), ...packages])],
    owner_decisions_needed: [...new Set([...(previous.owner_decisions_needed ?? []).filter((id) => !id.startsWith(`${projectKey}:`)), ...decisions])], next_suggested_run: nextCommand
  };

  await writeJson(join(projectOut, "project-profile.json"), discovered);
  await writeJson(join(projectOut, "validation-profile.json"), { key: profileKey, discovered: discovered.validation_profile, authority: profile });
  await writeJson(join(projectOut, "risk-map.json"), pickRisk(discovered));
  await writeJson(join(projectOut, "candidate-policy.json"), discovered.candidate_policy);
  await writeJson(join(projectOut, "authority.json"), { requested_profile: requestedProfile, selected_profile: profileKey, recommendation: discovered.recommended_authority_profile, profile, autopilot: Boolean(options.autopilot) });
  await writeJson(join(projectOut, "results.json"), { project: projectKey, candidates, selected: selected.map((x) => x.id), outcomes, source_unchanged: true });
  await writeFile(join(projectOut, "candidate-selection-report.md"), selectionReport(candidates, selected, outcomes));
  const cacheRoot = resolve(options.cache ?? ".runforge-cache/projects");
  const cacheProfile = join(cacheRoot, projectKey, "project-profile.json");
  const cached = await optionalJson<{ repo_head?: string; profile_hash?: string }>(cacheProfile);
  const cacheStatus = cached?.repo_head === discovered.repo_head && cached?.profile_hash === discovered.profile_hash ? "verified_current" : cached ? "refreshed" : "created";
  await writeJson(cacheProfile, { ...discovered, cache_status: cacheStatus, source_repo_path: project.path, last_safe_authority_profile: profileKey, last_outcomes: outcomes, last_known_runforge_branches: branchRefs });
  await writeJson(join(out, "ops-state.json"), state);
  const aggregate = await optionalJson<{ projects?: Record<string, unknown> }>(join(out, "results.json"));
  await writeJson(join(out, "results.json"), { status: "completed", projects: { ...(aggregate?.projects ?? {}), [projectKey]: { candidates_evaluated: candidates.length, candidates_executed: executed.length, patch_packages: packages.length, owner_decisions: decisions.length, target_unchanged: true } } });
  await updateInbox(join(out, "owner-inbox.md"), projectKey, outcomes, nextCommand);
  await writeFile(join(out, "execution-log.md"), `- ${new Date().toISOString()} ${projectKey}: profile=${profileKey}; evaluated=${candidates.length}; executed=${executed.length}; decisions=${decisions.length}; target-unchanged=yes; network/provider/db/prod/migrations=none\n`, { flag: "a" });
  await writeFile(join(out, "autopilot-report.md"), `# Autopilot report\n\nThe loop accepts unknown repository paths, selects a generic authority profile, removes state/package duplicates, executes deterministic low-risk candidates into patch packages, and stops ambiguous or unsafe work for the owner.\n\nNormal command: \`${nextCommand}\`\n`);
  await writeFile(join(out, "summary.md"), `# OPS-AUTOPILOT-1\n\nProject ${projectKey}: ${candidates.length} evaluated, ${executed.length} executed, ${packages.length} patch packages, ${decisions.length} owner decisions. Target HEAD and status remained unchanged.\n`);
  await writeJson(join(out, "packet-validation.json"), { valid: true, required_top_level_artifacts: ["summary.md", "results.json", "owner-inbox.md", "autopilot-report.md", "ops-state.json", "execution-log.md", "packet-validation.json"], safety: { target_unchanged: true, provider_calls: false, runtime_network: false, target_main_mutation: false } });
  return { out, project: projectKey, recommendedProfile: discovered.recommended_authority_profile, selectedProfile: profileKey, cacheProfile, cacheStatus, candidates: candidates.length, selected: selected.length, executed: executed.length, patchPackages: packages.length, ownerDecisions: decisions.length, targetUnchanged: true };
}

async function executeCandidate(repo: string, projectOut: string, item: Candidate, profile: Profile, autopilot: boolean): Promise<Outcome> {
  const dir = join(projectOut, "candidates", item.id); await mkdir(dir, { recursive: true });
  const packageDir = join(dir, "patch-package"); await mkdir(packageDir, { recursive: true });
  let outcome: Outcome;
  if (item.risk === "high") outcome = { candidate_id: item.id, outcome: "rejected_with_evidence", reason: "Candidate is outside the low-risk authority boundary." };
  else if (!autopilot || item.risk !== "low" || item.source !== "markdown_trailing_whitespace" || !item.file || !allows(profile, item.file)) outcome = { candidate_id: item.id, outcome: "owner_decision_needed", reason: autopilot ? "The candidate requires product judgment or authority expansion." : "Autopilot was not enabled." };
  else {
    const source = await readFile(join(repo, item.file), "utf8");
    const repaired = source.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
    const patch = unifiedPatch(item.file, source, repaired);
    await writeFile(join(packageDir, "patch.diff"), patch);
    await writeJson(join(packageDir, "manifest.json"), { candidate_id: item.id, source_head: snapshot(repo).head, files: [item.file], risk: "low", mutation_target: "patch-package-only", sha256: createHash("sha256").update(patch).digest("hex") });
    await writeFile(join(packageDir, "apply-instructions.md"), "Apply only after review in a non-main worktree with `git apply --check patch.diff && git apply patch.diff`.\n");
    outcome = { candidate_id: item.id, outcome: "patch_package_created", reason: "Deterministic whitespace-only repair is authority-covered; source repository was not edited.", patch_package: packageDir };
  }
  if (outcome.outcome !== "patch_package_created") await writeFile(join(packageDir, "NOT_CREATED.md"), `# Patch package not created\n\nOutcome: **${outcome.outcome}**. ${outcome.reason}\n`);
  await writeJson(join(dir, "classification.json"), { candidate: item, outcome });
  await writeJson(join(dir, "code-repair-plan.json"), { candidate_id: item.id, allowed_files: item.file ? [item.file] : [], transformation: item.source === "markdown_trailing_whitespace" ? "remove trailing horizontal whitespace" : "none without owner decision", authority: "low-risk only" });
  await writeFile(join(dir, "validation-before.md"), `# Validation before\n\nStatic evidence captured at ${item.evidence}. Source HEAD: ${snapshot(repo).head}. Runtime/network commands were not needed.\n`);
  await writeFile(join(dir, "validation-after.md"), `# Validation after\n\nOutcome: **${outcome.outcome}**. ${outcome.outcome === "patch_package_created" ? "Patch is whitespace-only and source HEAD/status are unchanged." : "No patch was applied."}\n`);
  await writeFile(join(dir, "ci-analysis.md"), "# CI analysis\n\nNo draft PR was created. CI monitoring is not applicable; provider calls were not made.\n");
  await writeFile(join(dir, "summary.md"), `# ${item.id}\n\n- Classification: ${item.risk}\n- Outcome: ${outcome.outcome}\n- Reason: ${outcome.reason}\n`);
  return outcome;
}

async function discover(repo: string, seen: string[], packaged: string[]): Promise<Candidate[]> {
  const files = (await walk(repo, 4)).filter((file) => /(^|\/)(src|test|tests|docs)\//.test(file) || /(^|\/)README[^/]*\.md$/i.test(file)).filter((file) => /\.(ts|tsx|js|jsx|md)$/.test(file)).slice(0, 300);
  const found: Candidate[] = [];
  for (const file of files) {
    const text = await readFile(join(repo, file), "utf8").catch(() => ""); const lines = text.split("\n");
    const whitespace = file.endsWith(".md") ? lines.findIndex((line) => /[ \t]+$/.test(line)) : -1;
    if (whitespace >= 0) found.push(makeCandidate(`trim-${slug(file)}`, "markdown_trailing_whitespace", "Remove trailing whitespace from Markdown", "low", file, whitespace + 1, seen, packaged, "execute_patch_package"));
    const todo = lines.findIndex((line) => /\b(TODO|FIXME)\b/.test(line));
    if (todo >= 0) found.push(makeCandidate(`todo-${slug(file)}`, "safe_todo", lines[todo].trim().slice(0, 140), file.endsWith(".md") || /test/.test(file) ? "medium" : "high", file, todo + 1, seen, packaged, "owner_review"));
    if (found.length >= 20) break;
  }
  const pkg = await optionalJson<{ scripts?: Record<string, string> }>(join(repo, "package.json"));
  if (pkg?.scripts && !pkg.scripts.typecheck) found.push(makeCandidate("validation-typecheck-gap", "package_script_gap", "No typecheck script declared", "medium", "package.json", 1, seen, packaged, "owner_review"));
  if (pkg?.scripts && !pkg.scripts.test) found.push(makeCandidate("validation-test-gap", "package_script_gap", "No test script declared", "medium", "package.json", 1, seen, packaged, "owner_review"));
  if (!found.length) found.push(makeCandidate("no-obvious-safe-candidate", "bounded_scan", "No obvious safe candidate in bounded local scan", "high", undefined, undefined, seen, packaged, "reject_with_evidence"));
  return found;
}

function makeCandidate(id: string, source: string, title: string, risk: Candidate["risk"], file: string | undefined, line: number | undefined, seen: string[], packaged: string[], action: string): Candidate { return { id, source, title, risk, file, line, duplicate: seen.includes(id) || packaged.includes(id), recommended_action: action, evidence: file ? `${file}:${line ?? 1}` : "bounded local repository scan" }; }
async function existingPackages(projectOut: string) { const root = join(projectOut, "candidates"); const entries = await readdir(root, { withFileTypes: true }).catch(() => []); const result: string[] = []; for (const entry of entries) if (entry.isDirectory()) { try { await access(join(root, entry.name, "patch-package", "manifest.json")); result.push(entry.name); } catch { /* absent */ } } return result; }
function unifiedPatch(file: string, before: string, after: string) { const old = before.split("\n"), next = after.split("\n"); let body = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${old.length} +1,${next.length} @@\n`; for (let i = 0; i < old.length; i++) body += old[i] === next[i] ? ` ${old[i]}\n` : `-${old[i]}\n+${next[i]}\n`; return body; }
function allows(profile: Profile, file: string) { return profile.publication_permission !== "none" && file.endsWith(".md") && !(profile.forbidden_file_patterns ?? []).some((pattern) => pattern.includes(".env") && file.includes(".env")); }
function pickRisk(value: Awaited<ReturnType<typeof discoverProject>>) { return { risky_file_patterns: value.risky_file_patterns, forbidden_file_patterns: value.forbidden_file_patterns, db_indicators: value.db_indicators, prod_indicators: value.prod_indicators, secret_indicators: value.secret_indicators, migration_indicators: value.migration_indicators, deploy_indicators: value.deploy_indicators }; }
function snapshot(repo: string) { return { head: git(repo, ["rev-parse", "HEAD"]), status: git(repo, ["status", "--porcelain=v1"]) }; }
function git(repo: string, args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function walk(root: string, depth: number, dir = ""): Promise<string[]> { if (depth < 0) return []; const entries = await readdir(join(root, dir), { withFileTypes: true }); const output: string[] = []; for (const entry of entries) { if ([".git", "node_modules", "dist", "build", ".next", ".runforge-cache"].includes(entry.name)) continue; const rel = join(dir, entry.name); if (entry.isDirectory()) output.push(...await walk(root, depth - 1, rel)); else output.push(rel); } return output; }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function optionalJson<T>(path: string): Promise<T | null> { try { return await json<T>(path); } catch { return null; } }
async function writeJson(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function updateInbox(path: string, project: string, outcomes: Outcome[], next: string) { const old = await readFile(path, "utf8").catch(() => "# Owner inbox\n"); const clean = old.replace(new RegExp(`\\n## Project: ${escapeRegex(project)}[\\s\\S]*?(?=\\n## Project:|$)`), ""); const decisions = outcomes.filter((x) => x.outcome === "owner_decision_needed"); await writeFile(path, `${clean.trimEnd()}\n\n## Project: ${project}\n\n- Patch packages created: ${outcomes.filter((x) => x.outcome === "patch_package_created").length}\n- Duplicates skipped: ${outcomes.filter((x) => x.outcome === "skip_duplicate").length}\n- Rejected with evidence: ${outcomes.filter((x) => x.outcome === "rejected_with_evidence").length}\n- Owner decisions needed: ${decisions.length}\n${decisions.map((x) => `  - \`${x.candidate_id}\`: ${x.reason}`).join("\n") || "  - None."}\n\nNext normal run: \`${next}\`\n`); }
function selectionReport(all: Candidate[], selected: Candidate[], outcomes: Outcome[]) { return `# Candidate selection\n\n- Evaluated: ${all.length}\n- Selected this run: ${selected.length}\n- Duplicate: ${all.filter((x) => x.duplicate).length}\n- Low / medium / high: ${["low", "medium", "high"].map((risk) => all.filter((x) => x.risk === risk).length).join(" / ")}\n\n${outcomes.map((x) => `- \`${x.candidate_id}\`: **${x.outcome}** — ${x.reason}`).join("\n")}\n`; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "candidate"; }
function shellDisplay(value: string) { return /\s/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value; }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
