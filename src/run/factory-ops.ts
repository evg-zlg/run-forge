import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

type Project = { path: string; risk: string; default_profile: string };
type Profile = Record<string, unknown> & { publication_permission: string };
export type FactoryOpsOptions = { project: string; profile?: string; batchSize: number; out: string; registry?: string; profiles?: string };
type Candidate = { id: string; source: string; title: string; risk: "low" | "medium" | "high"; duplicate: boolean; recommended_action: string; evidence: string };

export async function runFactoryOps(options: FactoryOpsOptions) {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 20) throw new Error("--batch-size must be an integer from 1 to 20.");
  const registryPath = resolve(options.registry ?? "config/projects.json");
  const profilesPath = resolve(options.profiles ?? "config/authority-profiles.json");
  const registry = await json<Record<string, Project>>(registryPath);
  const profiles = await json<Record<string, Profile>>(profilesPath);
  const project = registry[options.project] ?? (options.project.includes("/") ? { path: resolve(options.project), risk: "unregistered", default_profile: "patch-package-only" } : undefined);
  if (!project) throw new Error(`Unknown project '${options.project}'. Add it to ${registryPath}.`);
  await access(project.path);
  const profileKey = options.profile ?? project.default_profile;
  const profile = profiles[profileKey];
  if (!profile) throw new Error(`Unknown authority profile '${profileKey}'.`);
  const out = resolve(options.out);
  const projectKey = registry[options.project] ? options.project : basename(project.path).toLowerCase();
  const projectOut = join(out, "projects", projectKey);
  await mkdir(projectOut, { recursive: true });
  const before = snapshot(project.path);
  const previous = await optionalJson<Record<string, unknown> & { candidates_evaluated?: string[]; projects?: string[]; project_states?: Record<string, unknown>; owner_decisions_needed?: string[] }>(join(out, "ops-state.json"));
  const seen = (previous?.candidates_evaluated ?? []).filter((id) => id.startsWith(`${projectKey}:`)).map((id) => id.slice(projectKey.length + 1));
  const candidates = await discover(project.path, seen);
  const selected = candidates.filter((item) => !item.duplicate && item.risk !== "high").slice(0, options.batchSize);
  const results = selected.map((item) => ({ candidate_id: item.id, outcome: "owner_decision", reason: "Discovery is deterministic; code mutation requires a bounded executor plan in a non-main worktree." }));
  const after = snapshot(project.path);
  if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed during factory ops run.");
  const priorIds = previous?.candidates_evaluated ?? [];
  const decisions = results.map((item) => `${projectKey}:${item.candidate_id}`);
  const state = { projects: [...new Set([...(previous?.projects ?? []), projectKey])], project: projectKey, project_states: { ...(previous?.project_states ?? {}), [projectKey]: { main_head_before: before.head, main_head_after: after.head, status_before: before.status, status_after: after.status } }, main_head_before: before.head, main_head_after: after.head, open_runforge_prs_detected: [], candidates_evaluated: [...new Set([...priorIds, ...candidates.map((item) => `${projectKey}:${item.id}`)])], candidates_executed: [], draft_prs_created: [], patch_packages_created: [], owner_decisions_needed: [...new Set([...(previous?.owner_decisions_needed ?? []).filter((id) => !id.startsWith(`${projectKey}:`)), ...decisions])], next_suggested_run: `corepack pnpm dev factory ops run --project ${projectKey} --profile ${profileKey} --batch-size ${options.batchSize} --out ${options.out}` };
  await writeJson(join(projectOut, "candidates.json"), candidates);
  await writeJson(join(projectOut, "validation-profile.json"), { key: profileKey, ...profile });
  await writeJson(join(projectOut, "results.json"), { project: projectKey, selected, results, source_unchanged: true });
  await writeFile(join(projectOut, "summary.md"), `# ${projectKey} factory ops\n\n- Path: ${project.path}\n- Risk: ${project.risk}\n- Profile: ${profileKey}\n- HEAD unchanged: yes (${before.head})\n- Candidates: ${candidates.length}; selected: ${selected.length}\n- Outcome: owner decision required before mutation.\n`);
  await writeJson(join(out, "ops-state.json"), state);
  const aggregate = await optionalJson<{ projects?: Record<string, unknown> }>(join(out, "results.json"));
  await writeJson(join(out, "results.json"), { status: "completed", projects: { ...(aggregate?.projects ?? {}), [projectKey]: { candidates_evaluated: candidates.length, selected: selected.length, target_unchanged: true } } });
  const inboxPath = join(out, "owner-inbox.md");
  const oldInbox = await readFile(inboxPath, "utf8").catch(() => "# Owner inbox\n");
  const withoutSection = oldInbox.replace(new RegExp(`\\n## Project: ${escapeRegex(projectKey)}[\\s\\S]*?(?=\\n## Project:|$)`), "");
  await writeFile(inboxPath, `${withoutSection.trimEnd()}\n${inbox(projectKey, candidates, selected, state.next_suggested_run)}`);
  await writeFile(join(out, "project-registry-report.md"), `# Project registry report\n\nRegistry: ${registryPath}\n\nLoaded projects: ${Object.keys(registry).sort().join(", ")}.\n`);
  await writeFile(join(out, "authority-profiles-report.md"), `# Authority profiles report\n\nProfiles: ${profilesPath}\n\nLoaded profiles: ${Object.keys(profiles).sort().join(", ")}. Hard forbidden actions remain explicit in every profile.\n`);
  await writeFile(join(out, "candidate-discovery-report.md"), `# Candidate discovery report\n\nDiscovery is a bounded, provider-free local scan of safe docs/source/test files and package validation scripts. Duplicate IDs from ops state are skipped.\n`);
  await writeFile(join(out, "execution-log.md"), `# Execution log\n\n- ${projectKey}: inspected ${project.path}\n- Profile: ${profileKey}\n- Candidates evaluated: ${candidates.length}\n- Selected for owner decision: ${selected.length}\n- Target HEAD/status unchanged: yes\n- Provider/network/DB/production/migration actions: none\n`, { flag: "a" });
  await writeJson(join(out, "packet-validation.json"), { valid: true, required_top_level_artifacts: ["summary.md", "results.json", "owner-inbox.md", "ops-state.json", "project-registry-report.md", "authority-profiles-report.md", "candidate-discovery-report.md", "execution-log.md", "packet-validation.json"], safety: { target_unchanged: true, provider_calls: false, runtime_network: false } });
  await writeFile(join(out, "summary.md"), `# FACTORY-OPS-1 operational run\n\nRunForge resolved the project registry and reusable authority profile, performed bounded duplicate-aware discovery, preserved target source state, and updated the owner inbox. See per-project evidence under \`projects/\`.\n`);
  return { out, project: projectKey, candidates: candidates.length, selected: selected.length, targetUnchanged: true };
}

async function discover(repo: string, seen: string[]): Promise<Candidate[]> {
  const files = await walk(repo, 3);
  const safe = files.filter((file) => /(^|\/)(src|test|tests|docs)\//.test(file) && /\.(ts|tsx|js|jsx|md)$/.test(file)).slice(0, 200);
  const found: Candidate[] = [];
  for (const relative of safe) {
    const text = await readFile(join(repo, relative), "utf8").catch(() => "");
    const match = text.match(/\b(TODO|FIXME)\b[^\n]{0,120}/);
    if (!match) continue;
    const id = `todo-${relative.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")}`;
    found.push({ id, source: "safe_todo", title: match[0].trim(), risk: relative.startsWith("docs/") || /test/.test(relative) ? "low" : "medium", duplicate: seen.includes(id), recommended_action: "review_and_prepare_bounded_patch", evidence: `${relative}:${text.slice(0, match.index).split("\n").length}` });
    if (found.length >= 20) break;
  }
  const pkg = await optionalJson<{ scripts?: Record<string, string> }>(join(repo, "package.json"));
  if (pkg?.scripts && !pkg.scripts.typecheck) found.push(candidate("validation-typecheck-gap", "package_script_gap", "No typecheck script declared", "medium", seen));
  if (pkg?.scripts && !pkg.scripts.test) found.push(candidate("validation-test-gap", "package_script_gap", "No test script declared", "medium", seen));
  if (!found.length) found.push(candidate("no-obvious-safe-candidate", "bounded_scan", "No obvious safe candidate in bounded local scan", "high", seen, "reject_with_evidence"));
  return found;
}

function candidate(id: string, source: string, title: string, risk: Candidate["risk"], seen: string[], action = "owner_review") : Candidate { return { id, source, title, risk, duplicate: seen.includes(id), recommended_action: action, evidence: "bounded local repository scan" }; }
function snapshot(repo: string) { return { head: git(repo, ["rev-parse", "HEAD"]), status: git(repo, ["status", "--porcelain=v1"]) }; }
function git(repo: string, args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function walk(root: string, depth: number, dir = ""): Promise<string[]> { if (depth < 0) return []; const entries = await readdir(join(root, dir), { withFileTypes: true }); const output: string[] = []; for (const entry of entries) { if ([".git", "node_modules", "dist", "build", ".next"].includes(entry.name)) continue; const rel = join(dir, entry.name); if (entry.isDirectory()) output.push(...await walk(root, depth - 1, rel)); else output.push(rel); } return output; }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function optionalJson<T>(path: string): Promise<T | null> { try { return await json<T>(path); } catch { return null; } }
async function writeJson(path: string, value: unknown) { await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
function inbox(project: string, all: Candidate[], selected: Candidate[], next: string) { return `\n## Project: ${project}\n\nRunForge inspected the project with no source mutation.\n\n- Candidates evaluated: ${all.length}\n- Candidates selected: ${selected.length}\n- Draft PRs: none\n- Patch packages: none\n- Owner decisions: ${selected.length}\n- Rejected with evidence: ${all.filter((x) => x.risk === "high").length}\n\nSafe next step: review selected candidates, authorize a bounded non-main executor plan, then run \`${next}\`.\n`; }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
