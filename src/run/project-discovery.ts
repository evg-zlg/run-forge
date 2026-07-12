import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

type PackageJson = { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; bin?: unknown };
export type ProjectProfile = {
  project_name: string; project_key: string; repo_path: string; repo_head: string; package_manager: string; language_stack: string[];
  frameworks: string[]; test_commands: string[]; build_commands: string[]; typecheck_commands: string[]; lint_commands: string[];
  known_ci: string[]; default_branch: string; remote_info: { host: string; repository: string } | null;
  safe_file_patterns: string[]; risky_file_patterns: string[]; forbidden_file_patterns: string[];
  db_indicators: string[]; prod_indicators: string[]; secret_indicators: string[]; migration_indicators: string[]; deploy_indicators: string[];
  validation_profile: Record<string, unknown>; recommended_authority_profile: string; candidate_policy: Record<string, unknown>;
  last_discovered_at: string; confidence: number; open_questions: string[]; evidence_files: string[]; profile_hash: string;
};

export async function discoverProject(repoInput: string): Promise<ProjectProfile> {
  const repo = resolve(repoInput);
  const files = await walk(repo, 4);
  const pkg = await optionalJson<PackageJson>(join(repo, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const dependencies = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const packageManager = detectPackageManager(files);
  const frameworks = detectFrameworks(dependencies, files);
  const languageStack = detectLanguages(files);
  const indicators = riskIndicators(files);
  const commands = {
    test: scriptCommands(packageManager, scripts, /(^|:)test($|:)/), build: scriptCommands(packageManager, scripts, /(^|:)build($|:)/),
    typecheck: scriptCommands(packageManager, scripts, /(typecheck|type-check)/), lint: scriptCommands(packageManager, scripts, /(^|:)lint($|:)/)
  };
  const recommended = recommendAuthority(pkg, frameworks, indicators);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const projectName = pkg?.name ?? basename(repo);
  const projectKey = `${slug(projectName)}-${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
  const evidenceFiles = files.filter(isDiscoveryEvidence).slice(0, 100);
  const base = {
    project_name: projectName, project_key: projectKey, repo_path: repo, repo_head: head, package_manager: packageManager,
    language_stack: languageStack, frameworks, test_commands: commands.test, build_commands: commands.build,
    typecheck_commands: commands.typecheck, lint_commands: commands.lint, known_ci: knownCi(files),
    default_branch: defaultBranch(repo), remote_info: remoteInfo(repo), safe_file_patterns: ["src/**", "tests/**", "test/**", "docs/**", "*.md"],
    risky_file_patterns: ["config/**", "scripts/**", "infra/**", "Dockerfile*", ".github/workflows/**"],
    forbidden_file_patterns: ["**/.env*", "**/secrets/**", "**/migrations/**", "**/deploy/**", "**/infra/**"],
    ...indicators,
    validation_profile: { network: "disabled", setup: "owner_review_if_required", commands, forbidden_command_terms: ["migrate", "deploy", "release", "production", "seed"] },
    recommended_authority_profile: recommended,
    candidate_policy: { sources: ["safe_todo", "validation_script_gap", "docs_test_mismatch", "small_input_validation"], max_files: 5, exclude_risk_zones: true, duplicate_key: "candidate-id+repo-head", require_non_main_workspace_for_edits: true },
    last_discovered_at: new Date().toISOString(), confidence: confidence(pkg, files, commands),
    open_questions: [commands.test.length ? "" : "No declared test command was found.", languageStack.includes("typescript") && !commands.typecheck.length ? "No declared typecheck command was found." : ""].filter(Boolean), evidence_files: evidenceFiles
  };
  return { ...base, profile_hash: createHash("sha256").update(JSON.stringify({ ...base, last_discovered_at: undefined })).digest("hex") };
}

function detectPackageManager(files: string[]) { if (files.includes("pnpm-lock.yaml")) return "pnpm"; if (files.includes("yarn.lock")) return "yarn"; if (files.includes("package-lock.json")) return "npm"; if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun"; return files.includes("package.json") ? "npm-compatible-unknown" : "unknown"; }
function detectFrameworks(deps: Record<string, string>, files: string[]) { const names = ["next", "react", "vue", "@angular/core", "svelte", "express", "fastify", "commander", "vite", "vitest", "playwright"].filter((name) => name in deps); if (files.some((x) => /(^|\/)Dockerfile$/.test(x))) names.push("docker"); return [...new Set(names)]; }
function detectLanguages(files: string[]) { const values = new Set<string>(); for (const file of files) { if (/\.tsx?$/.test(file)) values.add("typescript"); else if (/\.jsx?$/.test(file)) values.add("javascript"); else if (/\.py$/.test(file)) values.add("python"); else if (/\.go$/.test(file)) values.add("go"); else if (/\.rs$/.test(file)) values.add("rust"); else if (/\.swift$/.test(file)) values.add("swift"); } return [...values]; }
function riskIndicators(files: string[]) { const pick = (pattern: RegExp) => files.filter((file) => pattern.test(file)).slice(0, 30); return { db_indicators: pick(/(^|\/)(db|database|prisma)(\/|$)|\.sql$/i), prod_indicators: pick(/prod(uction)?/i), secret_indicators: pick(/(^|\/)(\.env\.example|\.env\.sample)$|secret/i), migration_indicators: pick(/(^|\/)migrations?(\/|$)/i), deploy_indicators: pick(/(^|\/)(deploy|infra|terraform|helm|k8s)(\/|$)|Dockerfile/i) }; }
function recommendAuthority(pkg: PackageJson | null, frameworks: string[], risk: ReturnType<typeof riskIndicators>) { if (risk.db_indicators.length || risk.prod_indicators.length || risk.migration_indicators.length) return "read-only-triage"; const frontend = frameworks.some((x) => ["next", "react", "vue", "@angular/core", "svelte", "vite"].includes(x)); if (frontend) return "frontend-low-risk"; if (pkg?.bin || frameworks.includes("commander")) return "cli-tooling-low-risk"; return "auto-low-risk"; }
function scriptCommands(packageManager: string, scripts: Record<string, string>, pattern: RegExp) { const runner = packageManager === "unknown" ? "package-manager" : packageManager.replace(/-compatible-unknown$/, ""); return Object.keys(scripts).filter((name) => pattern.test(name)).slice(0, 8).map((name) => `${runner} run ${name}`); }
function knownCi(files: string[]) { const ci = new Set<string>(); if (files.some((x) => x.startsWith(".github/workflows/"))) ci.add("github-actions"); if (files.some((x) => /(^|\/)\.buildkite(\/|$)|buildkite/i.test(x))) ci.add("buildkite"); if (files.includes(".gitlab-ci.yml")) ci.add("gitlab-ci"); return [...ci]; }
function defaultBranch(repo: string) { const symbolic = gitOptional(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); return symbolic?.replace(/^origin\//, "") ?? "unknown"; }
function remoteInfo(repo: string) { const url = gitOptional(repo, ["remote", "get-url", "origin"]); if (!url) return null; const clean = url.replace(/^.*@/, "").replace(/^https?:\/\/[^/]+@/, "https://"); const match = clean.match(/^(?:https?:\/\/)?([^/:]+)[:/]([^/]+\/[^/]+?)(?:\.git)?$/); return match ? { host: match[1], repository: match[2] } : null; }
function confidence(pkg: PackageJson | null, files: string[], commands: Record<string, string[]>) { let score = pkg ? 0.45 : 0.2; if (files.some((x) => /lock/.test(x))) score += 0.15; if (commands.test.length) score += 0.15; if (files.some((x) => /README/i.test(x))) score += 0.1; if (knownCi(files).length) score += 0.1; return Math.min(1, score); }
function isDiscoveryEvidence(file: string) { return /(^|\/)(package\.json|README[^/]*|CONTRIBUTING[^/]*|Dockerfile[^/]*|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.github\/workflows\/[^/]+|\.buildkite\/[^/]+)$/i.test(file); }
async function walk(root: string, depth: number, dir = ""): Promise<string[]> { if (depth < 0) return []; const entries = await readdir(join(root, dir), { withFileTypes: true }); const output: string[] = []; for (const entry of entries) { if ([".git", "node_modules", "dist", "build", ".next", ".runforge-cache"].includes(entry.name)) continue; const relative = join(dir, entry.name); if (entry.isDirectory()) output.push(...await walk(root, depth - 1, relative)); else output.push(relative); } return output; }
async function optionalJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; } }
function git(repo: string, args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function gitOptional(repo: string, args: string[]) { try { return git(repo, args); } catch { return null; } }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"; }
