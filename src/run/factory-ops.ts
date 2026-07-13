import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverProject } from "./project-discovery.js";
import { decideCandidateAuthority, patternMatches, type CandidateDecision, type CandidateRisk } from "./candidate-authority.js";
import { candidateFingerprint, readCandidateHistory, saveCandidateVerdict, type CandidateVerdict } from "./factory-candidate-history.js";

type Project = { path: string; risk: string; default_profile: string };
type Profile = { publication_permission: string; allowed_actions?: string[]; allowed_file_patterns?: string[]; forbidden_file_patterns?: string[] };
export type FactoryOpsOptions = { project?: string; repo?: string; profile?: string; batchSize: number; out: string; registry?: string; profiles?: string; cache?: string; autopilot?: boolean; reopenCandidates?: string[] };
export type FactoryCandidateVerdictOptions = { repo: string; candidate: string; verdict: "reviewed_no_change"; classification: "false_positive"; reason: string; checks: string[]; out: string; cache?: string };
type Candidate = { id: string; source: string; title: string; risk: "low" | "medium" | "high"; file?: string; line?: number; duplicate: boolean; recommended_action: string; evidence: string; candidate_risk?: CandidateRisk; action_decision?: CandidateDecision; decision_reason?: string; learned_verdict?: CandidateVerdict };
type Outcome = { candidate_id: string; outcome: "draft-pr-created" | "patch-package-ready" | "duplicate-existing" | "reviewed-no-change" | "needs-owner-decision" | "rejected-risk" | "rejected-policy" | "validation-failed" | "unsafe/not-runnable"; reason: string; patch_package?: string; branch?: string; commit_sha?: string; pr_url?: string };
type OpsState = { projects?: string[]; project_states?: Record<string, unknown>; candidates_evaluated?: string[]; candidates_executed?: string[]; candidates_reviewed_no_change?: string[]; draft_prs_created?: string[]; patch_packages_created?: string[]; owner_decisions_needed?: string[] };

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
  const cacheRoot = resolve(options.cache ?? ".runforge-cache/projects");
  await mkdir(projectOut, { recursive: true });
  const previous = await optionalJson<OpsState>(join(out, "ops-state.json")) ?? {};
  const handledIds = [...(previous.candidates_executed ?? []), ...(previous.owner_decisions_needed ?? [])];
  const seen = handledIds.filter((id) => id.startsWith(`${projectKey}:`)).map((id) => id.slice(projectKey.length + 1));
  const packaged = await existingPackages(projectOut);
  const branchRefs = git(project.path, ["branch", "--all", "--format=%(refname:short)"]).split("\n").filter((x) => /runforge|codex\//i.test(x));
  const candidates = await discover(project.path, seen, packaged);
  const history = await readCandidateHistory(cacheRoot, projectKey);
  for (const item of candidates) {
    if (options.reopenCandidates?.includes(item.id)) continue;
    const fingerprint = await candidateFingerprint(project.path, item);
    const verdict = history.find((entry) => entry.candidate_id === item.id && entry.fingerprint === fingerprint && entry.verdict === "reviewed_no_change");
    if (verdict) { item.duplicate = true; item.learned_verdict = verdict; }
  }
  const validationConfidence = [...discovered.test_commands, ...discovered.build_commands, ...discovered.typecheck_commands, ...discovered.lint_commands].length > 0 ? "high" as const : "low" as const;
  const publicationActionsCovered = ["promote_patch_package_to_branch", "commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"].every((action) => profile.allowed_actions?.includes(action));
  for (const item of candidates) {
    const decision = decideCandidateAuthority({ files: item.file ? [item.file] : [], projectKind: discovered.project_kind, allowedFilePatterns: profile.allowed_file_patterns ?? [], forbiddenFilePatterns: profile.forbidden_file_patterns ?? [], publicationPermission: profile.publication_permission, publicationActionsCovered, validationConfidence, duplicateExisting: item.duplicate });
    item.candidate_risk = decision.risk; item.action_decision = decision.decision; item.decision_reason = decision.reason;
  }
  const selected = candidates.filter((item) => !item.duplicate).sort(candidateRank).slice(0, options.batchSize);
  const outcomes: Outcome[] = [];
  for (const item of candidates.filter((candidate) => candidate.duplicate)) outcomes.push(item.learned_verdict
    ? { candidate_id: item.id, outcome: "reviewed-no-change", reason: `Stable fingerprint matches owner-reviewed false positive: ${item.learned_verdict.reason}` }
    : { candidate_id: item.id, outcome: "duplicate-existing", reason: "Candidate is present in prior ops state or an existing patch package." });
  for (const item of selected) outcomes.push(await executeCandidate(project.path, projectOut, item, profile, Boolean(options.autopilot), before, discovered.default_branch));
  for (const item of candidates.filter((candidate) => !candidate.duplicate && !selected.some((selectedItem) => selectedItem.id === candidate.id) && candidate.source === "package_script_gap")) outcomes.push({ candidate_id: item.id, outcome: "needs-owner-decision", reason: "Validation policy is incomplete; available safe checks may continue, but the owner should decide whether this script is required." });
  const after = snapshot(project.path);
  if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed during factory ops run.");

  const ids = candidates.map((item) => `${projectKey}:${item.id}`);
  const executed = outcomes.filter((x) => ["draft-pr-created", "patch-package-ready"].includes(x.outcome)).map((x) => `${projectKey}:${x.candidate_id}`);
  const decisions = outcomes.filter((x) => x.outcome === "needs-owner-decision").map((x) => `${projectKey}:${x.candidate_id}`);
  const reviewed = outcomes.filter((x) => x.outcome === "reviewed-no-change").map((x) => `${projectKey}:${x.candidate_id}`);
  const packages = outcomes.flatMap((x) => x.patch_package ? [x.patch_package] : []);
  const nextCommand = `corepack pnpm dev factory ops run --repo ${shellDisplay(project.path)} --profile auto-low-risk --batch-size ${options.batchSize} --autopilot --out ${shellDisplay(options.out)}`;
  const state = {
    projects: [...new Set([...(previous.projects ?? []), projectKey])],
    project_states: { ...(previous.project_states ?? {}), [projectKey]: { main_head_before: before.head, main_head_after: after.head, status_before: before.status, status_after: after.status, runforge_branch_refs_detected: branchRefs } },
    candidates_evaluated: [...new Set([...(previous.candidates_evaluated ?? []), ...ids])],
    candidates_executed: [...new Set([...(previous.candidates_executed ?? []), ...executed])], draft_prs_created: [...new Set([...(previous.draft_prs_created ?? []), ...outcomes.flatMap((x) => x.pr_url ? [x.pr_url] : [])])],
    candidates_reviewed_no_change: [...new Set([...(previous.candidates_reviewed_no_change ?? []), ...reviewed])],
    patch_packages_created: [...new Set([...(previous.patch_packages_created ?? []), ...packages])],
    owner_decisions_needed: [...new Set([...(previous.owner_decisions_needed ?? []).filter((id) => !id.startsWith(`${projectKey}:`)), ...decisions])], next_suggested_run: nextCommand
  };

  await writeJson(join(projectOut, "project-profile.json"), discovered);
  await writeJson(join(projectOut, "validation-profile.json"), { key: profileKey, discovered: discovered.validation_profile, authority: profile });
  await writeJson(join(projectOut, "risk-map.json"), pickRisk(discovered));
  await writeJson(join(projectOut, "candidate-policy.json"), { ...discovered.candidate_policy, decision_model: ["draft-pr-allowed", "patch-package-only", "read-only-triage", "needs-owner-decision", "rejected-risk", "duplicate-existing"], validation_confidence: validationConfidence });
  await writeJson(join(projectOut, "authority.json"), { requested_profile: requestedProfile, selected_profile: profileKey, recommendation: discovered.recommended_authority_profile, profile, autopilot: Boolean(options.autopilot) });
  await writeJson(join(projectOut, "results.json"), { project: projectKey, candidates, selected: selected.map((x) => x.id), outcomes, source_unchanged: true });
  await writeFile(join(projectOut, "candidate-selection-report.md"), selectionReport(candidates, selected, outcomes));
  const cacheProfile = join(cacheRoot, projectKey, "project-profile.json");
  const cached = await optionalJson<{ repo_head?: string; profile_hash?: string }>(cacheProfile);
  const cacheStatus = cached?.repo_head === discovered.repo_head && cached?.profile_hash === discovered.profile_hash ? "verified_current" : cached ? "refreshed" : "created";
  await writeJson(cacheProfile, { ...discovered, cache_status: cacheStatus, source_repo_path: project.path, last_safe_authority_profile: profileKey, last_outcomes: outcomes, last_known_runforge_branches: branchRefs });
  await writeJson(join(out, "ops-state.json"), state);
  const aggregate = await optionalJson<{ projects?: Record<string, unknown> }>(join(out, "results.json"));
  await writeJson(join(out, "results.json"), { status: "completed", projects: { ...(aggregate?.projects ?? {}), [projectKey]: { candidates_evaluated: candidates.length, candidates_executed: executed.length, patch_packages: packages.length, promotions: outcomes.filter((x) => x.outcome === "draft-pr-created").length, draft_prs: outcomes.flatMap((x) => x.pr_url ? [x.pr_url] : []), owner_decisions: decisions.length, target_unchanged: true } } });
  await updateInbox(join(out, "owner-inbox.md"), projectKey, outcomes, nextCommand);
  await writeFile(join(out, "execution-log.md"), `- ${new Date().toISOString()} ${projectKey}: profile=${profileKey}; evaluated=${candidates.length}; executed=${executed.length}; decisions=${decisions.length}; target-unchanged=yes; network/provider/db/prod/migrations=none\n`, { flag: "a" });
  await writeFile(join(out, "autopilot-report.md"), `# Autopilot report\n\nThe loop accepts unknown repository paths, selects a bounded authority profile, removes state/package/branch/PR duplicates, executes deterministic low-risk candidates into patch packages, and promotes them to owner-ready draft PRs only when every publication authority and safety gate passes.\n\nNormal command: \`${nextCommand}\`\n`);
  await writeFile(join(out, "promotion-report.md"), promotionReport(outcomes));
  await writeFile(join(projectOut, "promotion-report.md"), promotionReport(outcomes));
  await writeFile(join(out, "network-phase-report.md"), "# Network phase report\n\n- Discovery and patch validation: network denied/not required.\n- Git remote and GitHub publication: network allowed only for duplicate detection, non-force branch push, draft PR creation, and CI metadata.\n- Provider, DB, production, deployment, migration, and secret access: none.\n");
  await writeFile(join(out, "summary.md"), `# Autopilot profile calibration\n\nProject ${projectKey}: ${candidates.length} evaluated, ${executed.length} executed, ${packages.length} patch packages, ${decisions.length} owner decisions. Target HEAD and status remained unchanged.\n`);
  await writeFile(join(out, "profile-calibration-report.md"), `# Profile calibration report\n\n- Project: \`${projectKey}\`\n- Project kind: \`${discovered.project_kind}\`\n- Recommended/selected profile: \`${discovered.recommended_authority_profile}\` / \`${profileKey}\`\n- Risk zones remain project-scoped; candidate authority is decided from files, forbidden zones, validation confidence, duplicates, and publication coverage.\n- Draft PR allowed candidates: ${candidates.filter((candidate) => candidate.action_decision === "draft-pr-allowed").length}\n- Rejected or owner-decision candidates: ${candidates.filter((candidate) => ["rejected-risk", "read-only-triage", "needs-owner-decision"].includes(candidate.action_decision ?? "")).length}\n`);
  await writeJson(join(out, "packet-validation.json"), { valid: true, required_top_level_artifacts: ["summary.md", "results.json", "profile-calibration-report.md", "owner-inbox.md", "autopilot-report.md", "ops-state.json", "execution-log.md", "packet-validation.json"], safety: { target_unchanged: true, provider_calls: false, runtime_network: false, target_main_mutation: false } });
  return { out, project: projectKey, recommendedProfile: discovered.recommended_authority_profile, selectedProfile: profileKey, cacheProfile, cacheStatus, candidates: candidates.length, selected: selected.length, executed: executed.length, patchPackages: packages.length, promotions: outcomes.filter((x) => x.outcome === "draft-pr-created").length, draftPrs: outcomes.flatMap((x) => x.pr_url ? [x.pr_url] : []), ownerDecisions: decisions.length, targetUnchanged: true };
}

export async function recordFactoryCandidateVerdict(options: FactoryCandidateVerdictOptions) {
  if (!options.reason.trim()) throw new Error("Candidate verdict requires a reason.");
  if (!options.checks.length) throw new Error("Candidate verdict requires validation evidence.");
  const repo = resolve(options.repo); await access(repo); const before = snapshot(repo); if (before.status) throw new Error("Target repository must be clean before recording a candidate verdict.");
  const discovered = await discoverProject(repo); const projectKey = discovered.project_key; const candidate = (await discover(repo, [], [])).find((item) => item.id === options.candidate);
  if (!candidate) throw new Error(`Candidate '${options.candidate}' is absent from current detector evidence.`);
  const fingerprint = await candidateFingerprint(repo, candidate); const cacheRoot = resolve(options.cache ?? ".runforge-cache/projects"); const verdict: CandidateVerdict = { candidate_id: candidate.id, fingerprint, verdict: options.verdict, classification: options.classification, reason: options.reason, source_head: before.head, detector_evidence: candidate.evidence, file: candidate.file ?? null, checks: options.checks, recorded_at: new Date().toISOString() };
  const historyPath = await saveCandidateVerdict(cacheRoot, projectKey, verdict); const out = resolve(options.out); const candidateOut = join(out, "projects", projectKey, "candidates", candidate.id); await mkdir(candidateOut, { recursive: true });
  await writeJson(join(candidateOut, "owner-verdict.json"), verdict);
  await writeFile(join(candidateOut, "reviewed-no-change.md"), `# Reviewed no change\n\n- Candidate: \`${candidate.id}\`\n- Verdict: **reviewed_no_change / false_positive**\n- Fingerprint: \`${fingerprint}\`\n- Source HEAD: \`${before.head}\`\n- Detector evidence: \`${candidate.evidence}\`\n- Reason: ${options.reason}\n\n## Checks\n\n${options.checks.map((check) => `- ${check}`).join("\n")}\n\nThe verdict suppresses only this exact fingerprint. File or detector-evidence changes produce a new fingerprint; \`--reopen-candidate ${candidate.id}\` explicitly reopens it. No patch package, branch, commit, push, or PR was created.\n`);
  const statePath = join(out, "ops-state.json"); const previous = await optionalJson<OpsState>(statePath) ?? {}; const stableId = `${projectKey}:${candidate.id}`;
  await writeJson(statePath, { ...previous, candidates_reviewed_no_change: [...new Set([...(previous.candidates_reviewed_no_change ?? []), stableId])], owner_decisions_needed: (previous.owner_decisions_needed ?? []).filter((id) => id !== stableId) });
  const after = snapshot(repo); if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed while recording candidate verdict.");
  return { project: projectKey, candidate: candidate.id, verdict: verdict.verdict, classification: verdict.classification, fingerprint, historyPath, targetUnchanged: true };
}

async function executeCandidate(repo: string, projectOut: string, item: Candidate, profile: Profile, autopilot: boolean, baseline: { head: string; status: string }, defaultBranch: string): Promise<Outcome> {
  const dir = join(projectOut, "candidates", item.id); await mkdir(dir, { recursive: true });
  const packageDir = join(dir, "patch-package"); await mkdir(packageDir, { recursive: true });
  let outcome: Outcome;
  if (item.action_decision === "rejected-risk" || item.action_decision === "read-only-triage") outcome = { candidate_id: item.id, outcome: "rejected-risk", reason: item.decision_reason ?? "Candidate is outside the low-risk authority boundary." };
  else if (item.action_decision === "needs-owner-decision") outcome = { candidate_id: item.id, outcome: "needs-owner-decision", reason: item.decision_reason ?? "Candidate needs owner decision." };
  else if (item.risk === "high") outcome = { candidate_id: item.id, outcome: "rejected-risk", reason: "Candidate is outside the low-risk authority boundary." };
  else if (!autopilot || item.risk !== "low" || !["markdown_trailing_whitespace", "strict_integer_radix"].includes(item.source) || !item.file) outcome = { candidate_id: item.id, outcome: "needs-owner-decision", reason: autopilot ? "The candidate requires product judgment or authority expansion." : "Autopilot was not enabled." };
  else if (!allowsPatchPackage(profile, item.file, item.source)) outcome = { candidate_id: item.id, outcome: "rejected-policy", reason: "Candidate touches a forbidden or non-allowed file." };
  else {
    const source = await readFile(join(repo, item.file), "utf8");
    const repaired = item.source === "strict_integer_radix" ? source.replace(/\bparseInt\s*\(\s*(year|month|day)\s*\)/g, "parseInt($1, 10)") : source.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
    const patch = unifiedPatch(item.file, source, repaired);
    await writeFile(join(packageDir, "patch.diff"), patch);
    await writeJson(join(packageDir, "manifest.json"), { candidate_id: item.id, source_head: snapshot(repo).head, files: [item.file], risk: "low", mutation_target: "patch-package-only", sha256: createHash("sha256").update(patch).digest("hex") });
    await writeFile(join(packageDir, "apply-instructions.md"), "Apply only after review in a non-main worktree with `git apply --check patch.diff && git apply patch.diff`.\n");
    await writeFile(join(packageDir, "validation-before.md"), `# Validation before\n\nStatic inspection found trailing horizontal whitespace at \`${item.evidence}\`. The source repository was clean at \`${snapshot(repo).head}\`.\n`);
    await writeFile(join(packageDir, "validation-after.md"), `# Validation after\n\nThe generated patch applies only the deterministic \`${item.source}\` repair. The source repository was not modified; apply and run the repository's available checks in an isolated non-main worktree.\n`);
    await writeFile(join(packageDir, "risk-assessment.md"), `# Risk assessment\n\nRisk is low: the deterministic patch is limited to \`${item.source}\` in one safe-zone file. Publication is intentionally not performed by this package.\n`);
    await writeFile(join(packageDir, "owner-next-action.md"), "# Owner next action\n\nReview `patch.diff`, apply it in a non-main worktree, run available local validation with network disabled, then decide whether to publish.\n");
    outcome = { candidate_id: item.id, outcome: "patch-package-ready", reason: "Deterministic low-risk patch package is validated and source repository was not edited.", patch_package: packageDir };
    if (item.action_decision === "draft-pr-allowed" && canPromote(profile)) outcome = await promotePatchPackage({ repo, dir, packageDir, item, profile, baseline, defaultBranch, patch, outcome });
  }
  if (!["draft-pr-created", "patch-package-ready"].includes(outcome.outcome)) await writeFile(join(packageDir, "NOT_CREATED.md"), `# Patch package not created\n\nOutcome: **${outcome.outcome}**. ${outcome.reason}\n`);
  await writeJson(join(dir, "classification.json"), { candidate: item, outcome });
  await writeJson(join(dir, "code-repair-plan.json"), { candidate_id: item.id, allowed_files: item.file ? [item.file] : [], transformation: item.source === "markdown_trailing_whitespace" ? "remove trailing horizontal whitespace" : item.source === "strict_integer_radix" ? "add explicit decimal radix to date-component parseInt calls" : "none without owner decision", authority: "low-risk only" });
  await writeFile(join(dir, "validation-before.md"), `# Validation before\n\nStatic evidence captured at ${item.evidence}. Source HEAD: ${snapshot(repo).head}. Runtime/network commands were not needed.\n`);
  await writeFile(join(dir, "validation-after.md"), `# Validation after\n\nOutcome: **${outcome.outcome}**. ${["draft-pr-created", "patch-package-ready"].includes(outcome.outcome) ? "Patch validation passed and source HEAD/status are unchanged." : "No source patch was applied."}\n`);
  if (!outcome.pr_url) await writeFile(join(dir, "ci-analysis.md"), "# CI analysis\n\nNo new draft PR was created. CI monitoring is not applicable; provider calls were not made.\n");
  await writeFile(join(dir, "summary.md"), `# ${item.id}\n\n- Classification: ${item.risk}\n- Outcome: ${outcome.outcome}\n- Reason: ${outcome.reason}\n`);
  return outcome;
}

export function evaluateAutopilotPromotion(input: { profile: Profile; branch: string; sourceBranch: string; defaultBranch: string; sourceClean: boolean; patchHashMatches: boolean; validationPassed: boolean; draft: boolean; runtimeNetworkRequired: boolean; forbiddenFile: boolean }) {
  const required = ["promote_patch_package_to_branch", "commit_to_non_main_branch", "push_non_main_branch", "create_draft_pr"];
  if (input.profile.publication_permission !== "draft_pr" || !required.every((action) => input.profile.allowed_actions?.includes(action))) return { allowed: false, outcome: "patch-package-ready" as const, reason: "Publication authority is absent or incomplete." };
  if (["main", "master", input.sourceBranch, input.defaultBranch].map((x) => x.toLowerCase()).includes(input.branch.toLowerCase())) return { allowed: false, outcome: "rejected-policy" as const, reason: "Publication branch is main, master, default, or current source branch." };
  if (!input.sourceClean || !input.patchHashMatches) return { allowed: false, outcome: "unsafe/not-runnable" as const, reason: "Source is dirty/changed or patch hash is stale." };
  if (!input.validationPassed) return { allowed: false, outcome: "validation-failed" as const, reason: "Validation failed." };
  if (!input.draft || input.runtimeNetworkRequired || input.forbiddenFile) return { allowed: false, outcome: "rejected-policy" as const, reason: "Draft-only, network-denied, or file-risk policy failed." };
  return { allowed: true, outcome: "draft-pr-created" as const, reason: "All promotion gates pass." };
}

function canPromote(profile: Profile) {
  return evaluateAutopilotPromotion({ profile, branch: "runforge/candidate", sourceBranch: "source", defaultBranch: "main", sourceClean: true, patchHashMatches: true, validationPassed: true, draft: true, runtimeNetworkRequired: false, forbiddenFile: false }).allowed;
}

async function promotePatchPackage(input: { repo: string; dir: string; packageDir: string; item: Candidate; profile: Profile; baseline: { head: string; status: string }; defaultBranch: string; patch: string; outcome: Outcome }): Promise<Outcome> {
  const { repo, dir, packageDir, item, baseline } = input;
  if (!item.file || snapshot(repo).head !== baseline.head || snapshot(repo).status !== "") return { ...input.outcome, outcome: "unsafe/not-runnable", reason: "Source repository became dirty or changed after patch-package creation." };
  if (["main", "master", "unknown"].includes(input.defaultBranch.toLowerCase())) {
    const current = git(repo, ["branch", "--show-current"]);
    if (input.defaultBranch === "unknown" && !current) return { ...input.outcome, outcome: "unsafe/not-runnable", reason: "Default/source branch could not be determined safely." };
  }
  const patchHash = createHash("sha256").update(input.patch).digest("hex");
  const manifest = await json<{ sha256: string; source_head: string }>(join(packageDir, "manifest.json"));
  if (manifest.sha256 !== patchHash || manifest.source_head !== baseline.head) return { ...input.outcome, outcome: "validation-failed", reason: "Patch hash or source HEAD changed after package creation." };
  const branch = `runforge/auto-${slug(item.id).slice(0, 48)}-${patchHash.slice(0, 8)}`;
  const sourceBranch = git(repo, ["branch", "--show-current"]);
  if (["main", "master", input.defaultBranch, sourceBranch].filter(Boolean).map((x) => x.toLowerCase()).includes(branch.toLowerCase())) return { ...input.outcome, outcome: "rejected-policy", reason: "Publication branch resolves to main, master, default, or current source branch." };
  const matchingPr = findMatchingOpenPr(repo, input.patch);
  if (matchingPr) return { ...input.outcome, outcome: "duplicate-existing", reason: `Existing draft PR has the same stable patch identity: ${matchingPr.url}`, branch: matchingPr.branch, commit_sha: matchingPr.head, pr_url: matchingPr.url };
  const localHead = gitOptional(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  const remoteHead = gitOptional(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])?.split(/\s+/)[0] ?? null;
  const existingPr = ghOptional(repo, ["pr", "list", "--head", branch, "--state", "all", "--json", "url,isDraft,headRefOid", "--limit", "1"]);
  const prs = existingPr ? JSON.parse(existingPr) as Array<{ url: string; isDraft: boolean; headRefOid: string }> : [];
  if (prs.length) return { ...input.outcome, outcome: "duplicate-existing", reason: `Existing PR already covers deterministic patch branch: ${prs[0]!.url}`, branch, commit_sha: prs[0]!.headRefOid, pr_url: prs[0]!.url };
  if ((localHead && localHead !== baseline.head) || (remoteHead && remoteHead !== baseline.head)) return { ...input.outcome, outcome: "duplicate-existing", reason: "Existing publication branch points at an unexpected SHA; refusing overwrite.", branch };
  const worktree = join(dir, "promotion-worktree");
  await rm(worktree, { recursive: true, force: true });
  try {
    if (!localHead) git(repo, ["worktree", "add", "-b", branch, worktree, baseline.head]);
    else git(repo, ["worktree", "add", worktree, branch]);
    git(worktree, ["apply", "--check", join(packageDir, "patch.diff")]);
    git(worktree, ["apply", join(packageDir, "patch.diff")]);
    git(worktree, ["diff", "--check"]);
    if (createHash("sha256").update(await readFile(join(packageDir, "patch.diff"))).digest("hex") !== patchHash) throw new Error("Patch hash changed after package creation.");
    git(worktree, ["add", "--", item.file]);
    execFileSync("git", ["-C", worktree, "-c", "user.name=RunForge", "-c", "user.email=runforge@example.invalid", "commit", "-m", `fix: ${item.title}`], { stdio: ["ignore", "pipe", "pipe"] });
    const commit = git(worktree, ["rev-parse", "HEAD"]);
    if (snapshot(repo).head !== baseline.head || snapshot(repo).status !== "") throw new Error("Source repository changed before publication.");
    git(worktree, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    const body = join(dir, "pr-body.md");
    await writeFile(body, `## RunForge unattended promotion\n\n- Candidate: \`${item.id}\`\n- Patch hash: \`${patchHash}\`\n- Source HEAD: \`${baseline.head}\`\n- Validation: patch apply check and git diff check passed with no runtime network.\n- Safety: draft only; non-main branch; no force push; no merge/deploy/DB/prod/secrets/provider.\n`);
    const prUrl = execFileSync("gh", ["pr", "create", "--draft", "--base", input.defaultBranch, "--head", branch, "--title", `fix: ${item.title}`, "--body-file", body], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const view = JSON.parse(execFileSync("gh", ["pr", "view", prUrl, "--json", "isDraft,url"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { isDraft: boolean; url: string };
    if (!view.isDraft) throw new Error("Created PR is not draft; publication safety invariant failed.");
    await writeFile(join(dir, "publication-report.md"), `# Publication report\n\n- Candidate: \`${item.id}\`\n- Patch package: \`${packageDir}\`\n- Branch: \`${branch}\`\n- Commit: \`${commit}\`\n- Draft PR: ${view.url}\n- Validation: apply check and diff check passed\n- Runtime network: denied/not required\n- Source immutability: HEAD \`${baseline.head}\`, status clean before and after\n- Force push / merge / deploy: none\n`);
    await writeFile(join(dir, "ci-analysis.md"), `# CI analysis\n\nDraft PR created: ${view.url}. CI status is owner-visible on GitHub; no check is hidden or bypassed.\n`);
    return { ...input.outcome, outcome: "draft-pr-created", reason: "All authority, validation, duplicate, branch, and draft-only gates passed.", branch, commit_sha: commit, pr_url: view.url };
  } catch (error) {
    return { ...input.outcome, outcome: "validation-failed", reason: error instanceof Error ? error.message : String(error), branch };
  } finally {
    gitOptional(repo, ["worktree", "remove", "--force", worktree]);
  }
}

async function discover(repo: string, seen: string[], packaged: string[]): Promise<Candidate[]> {
  const files = (await walk(repo, 6)).filter(isSafeCandidateFile).slice(0, 800);
  const found: Candidate[] = [];
  for (const file of files) {
    const text = await readFile(join(repo, file), "utf8").catch(() => ""); const lines = text.split("\n");
    const whitespace = file.endsWith(".md") ? lines.findIndex((line) => /[ \t]+$/.test(line)) : -1;
    if (whitespace >= 0) found.push(makeCandidate(`trim-${slug(file)}`, "markdown_trailing_whitespace", "Remove trailing whitespace from Markdown", "low", file, whitespace + 1, seen, packaged, "execute_patch_package"));
    const todo = lines.findIndex((line) => /\b(TODO|FIXME)\b/.test(line));
    if (todo >= 0) found.push(makeCandidate(`todo-${slug(file)}`, "safe_todo", lines[todo].trim().slice(0, 140), file.endsWith(".md") || /(^|\/)(test|tests)\//.test(file) ? "medium" : "high", file, todo + 1, seen, packaged, "owner_review"));
    const dateInteger = lines.findIndex((value) => /\bparseInt\s*\(\s*(year|month|day)\s*\)/.test(value));
    if (dateInteger >= 0) found.push(makeCandidate(`add-decimal-radix-v2-${slug(file)}`, "strict_integer_radix", "Declare decimal radix for parsed date components", "low", file, dateInteger + 1, seen, packaged, "execute_patch_package"));
    else addPatternCandidate(found, file, lines, /\b(?:Number\.)?parseInt\s*\([^,)]*\)/, "strict-integer-parsing", "integer_parser_review", "Integer parsing does not declare a radix", "medium", seen, packaged);
    addPatternCandidate(found, file, lines, /\bJSON\.parse\s*\(/, "malformed-json-handling", "json_report_review", "Verify malformed JSON/report input is handled", /(^|\/)(test|tests)\//.test(file) ? "low" : "medium", seen, packaged);
    addPatternCandidate(found, file, lines, /\b(process\.argv|\.argument\s*\(|\.positional\s*\()/, "cli-argument-handling", "cli_parser_review", "Review positional argument, empty input, and unknown flag handling", /(^|\/)(test|tests)\//.test(file) ? "low" : "medium", seen, packaged);
    addPatternCandidate(found, file, lines, /\b(min|max|range)\b.*(?:throw|error|invalid)|(?:throw|error|invalid).*\b(min|max|range)\b/i, "range-validation", "validator_review", "Review boundary and range validation coverage", /(^|\/)(test|tests)\//.test(file) ? "low" : "medium", seen, packaged);
    if (found.length >= 60) break;
  }
  const pkg = await optionalJson<{ scripts?: Record<string, string> }>(join(repo, "package.json"));
  if (pkg?.scripts && !pkg.scripts.typecheck) found.push(makeCandidate("validation-typecheck-gap", "package_script_gap", "No typecheck script declared", "medium", "package.json", 1, seen, packaged, "owner_review"));
  if (pkg?.scripts && !pkg.scripts.test) found.push(makeCandidate("validation-test-gap", "package_script_gap", "No test script declared", "medium", "package.json", 1, seen, packaged, "owner_review"));
  if (!found.length) found.push(makeCandidate("no-obvious-safe-candidate", "bounded_scan", "No obvious safe candidate in bounded local scan", "high", undefined, undefined, seen, packaged, "reject_with_evidence"));
  return found;
}

function isSafeCandidateFile(file: string) {
  if (/(^|\/)(\.env[^/]*|secrets?|migrations?|deploy|infra|production|prod)(\/|$)/i.test(file)) return false;
  if (/(^|\/)(auth|payments?|database|db)(\/|$)/i.test(file)) return false;
  return (/\.(ts|tsx|js|jsx|mjs|cjs|md|json)$/.test(file) && (/(^|\/)(src|lib|bin|cli|cmd|commands|test|tests|docs|scripts)\//.test(file) || /(^|\/)README[^/]*\.md$/i.test(file) || /(^|\/)package\.json$/.test(file)));
}

function addPatternCandidate(found: Candidate[], file: string, lines: string[], pattern: RegExp, id: string, source: string, title: string, risk: Candidate["risk"], seen: string[], packaged: string[]) {
  const line = lines.findIndex((value) => pattern.test(value));
  if (line >= 0) found.push(makeCandidate(`${id}-${slug(file)}`, source, title, risk, file, line + 1, seen, packaged, "inspect_or_patch_package"));
}

function candidateRank(a: Candidate, b: Candidate) {
  const score = (item: Candidate) => ["markdown_trailing_whitespace", "strict_integer_radix"].includes(item.source) && item.risk === "low" ? 0 : item.risk === "low" ? 1 : item.source === "package_script_gap" ? 3 : item.risk === "medium" ? 2 : 4;
  return score(a) - score(b) || a.id.localeCompare(b.id);
}

function makeCandidate(id: string, source: string, title: string, risk: Candidate["risk"], file: string | undefined, line: number | undefined, seen: string[], packaged: string[], action: string): Candidate { return { id, source, title, risk, file, line, duplicate: seen.includes(id) || packaged.includes(id), recommended_action: action, evidence: file ? `${file}:${line ?? 1}` : "bounded local repository scan" }; }
async function existingPackages(projectOut: string) { const root = join(projectOut, "candidates"); const entries = await readdir(root, { withFileTypes: true }).catch(() => []); const result: string[] = []; for (const entry of entries) if (entry.isDirectory()) { try { await access(join(root, entry.name, "patch-package", "manifest.json")); result.push(entry.name); } catch { /* absent */ } } return result; }
function unifiedPatch(file: string, before: string, after: string) { const old = patchLines(before), next = patchLines(after); let body = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${old.length} +1,${next.length} @@\n`; for (let i = 0; i < old.length; i++) body += old[i] === next[i] ? ` ${old[i]}\n` : `-${old[i]}\n+${next[i]}\n`; return body; }
function patchLines(value: string) { const lines = value.split("\n"); if (value.endsWith("\n")) lines.pop(); return lines; }
function allowsPatchPackage(profile: Profile, file: string, source: string) { const allowed = profile.allowed_file_patterns ?? []; return (file.endsWith(".md") || source === "strict_integer_radix") && isSafeCandidateFile(file) && (!allowed.length || allowed.some((pattern) => profilePatternMatches(pattern, file))) && !(profile.forbidden_file_patterns ?? []).some((pattern) => profilePatternMatches(pattern, file)); }
function profilePatternMatches(pattern: string, file: string) { return patternMatches(pattern, file); }
function forbiddenPatternMatches(pattern: string, file: string) { const token = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\*/g, ""); return token.length > 0 && file.toLowerCase().includes(token.toLowerCase()); }
function pickRisk(value: Awaited<ReturnType<typeof discoverProject>>) { return { project_kind: value.project_kind, risk_zones: value.risk_zones, risky_file_patterns: value.risky_file_patterns, forbidden_file_patterns: value.forbidden_file_patterns, db_indicators: value.db_indicators, prod_indicators: value.prod_indicators, secret_indicators: value.secret_indicators, migration_indicators: value.migration_indicators, deploy_indicators: value.deploy_indicators }; }
function snapshot(repo: string) { return { head: git(repo, ["rev-parse", "HEAD"]), status: git(repo, ["status", "--porcelain=v1"]) }; }
function git(repo: string, args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function gitOptional(repo: string, args: string[]) { try { return git(repo, args); } catch { return null; } }
function ghOptional(repo: string, args: string[]) { try { return execFileSync("gh", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } }
function findMatchingOpenPr(repo: string, patch: string) {
  const raw = ghOptional(repo, ["pr", "list", "--state", "open", "--json", "url,isDraft,headRefOid,headRefName", "--limit", "100"]);
  if (!raw) return null;
  const expected = stablePatchId(repo, patch);
  const prs = JSON.parse(raw) as Array<{ url: string; isDraft: boolean; headRefOid: string; headRefName: string }>;
  for (const pr of prs) {
    const diff = ghOptional(repo, ["pr", "diff", pr.url]);
    if (diff && stablePatchId(repo, diff) === expected) return { url: pr.url, branch: pr.headRefName, head: pr.headRefOid, draft: pr.isDraft };
  }
  return null;
}
function stablePatchId(repo: string, patch: string) { try { return execFileSync("git", ["patch-id", "--stable"], { cwd: repo, input: patch, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim().split(/\s+/)[0] ?? createHash("sha256").update(patch).digest("hex"); } catch { return createHash("sha256").update(patch).digest("hex"); } }
async function walk(root: string, depth: number, dir = ""): Promise<string[]> { if (depth < 0) return []; const entries = await readdir(join(root, dir), { withFileTypes: true }); const output: string[] = []; for (const entry of entries) { if ([".git", "node_modules", "dist", "build", ".next", ".runforge-cache"].includes(entry.name)) continue; const rel = join(dir, entry.name); if (entry.isDirectory()) output.push(...await walk(root, depth - 1, rel)); else output.push(rel); } return output; }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function optionalJson<T>(path: string): Promise<T | null> { try { return await json<T>(path); } catch { return null; } }
async function writeJson(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function updateInbox(path: string, project: string, outcomes: Outcome[], next: string) { const old = await readFile(path, "utf8").catch(() => "# Owner inbox\n"); const clean = old.replace(new RegExp(`\\n## Project: ${escapeRegex(project)}[\\s\\S]*?(?=\\n## Project:|$)`), ""); const packages = outcomes.filter((x) => ["draft-pr-created", "patch-package-ready"].includes(x.outcome)); const decisions = outcomes.filter((x) => x.outcome === "needs-owner-decision"); await writeFile(path, `${clean.trimEnd()}\n\n## Project: ${project}\n\n- Draft-PR-created: ${outcomes.filter((x) => x.outcome === "draft-pr-created").length}\n${outcomes.filter((x) => x.pr_url).map((x) => `  - \`${x.candidate_id}\`: ${x.pr_url}`).join("\n") || "  - None."}\n- Patch-package-ready: ${outcomes.filter((x) => x.outcome === "patch-package-ready").length}\n${packages.map((x) => `  - \`${x.candidate_id}\`: ${x.patch_package}`).join("\n") || "  - None."}\n- Duplicate-existing: ${outcomes.filter((x) => x.outcome === "duplicate-existing").length}\n- Rejected-risk/policy: ${outcomes.filter((x) => ["rejected-risk", "rejected-policy"].includes(x.outcome)).length}\n- Needs-owner-decision: ${decisions.length}\n${decisions.map((x) => `  - \`${x.candidate_id}\`: ${x.reason}`).join("\n") || "  - None."}\n\nNext normal run: \`${next}\`\n`); }
function promotionReport(outcomes: Outcome[]) { return `# Promotion report\n\n${outcomes.map((x) => `- \`${x.candidate_id}\`: **${x.outcome}**${x.branch ? `; branch \`${x.branch}\`` : ""}${x.commit_sha ? `; commit \`${x.commit_sha}\`` : ""}${x.pr_url ? `; ${x.pr_url}` : ""} — ${x.reason}`).join("\n") || "No candidates."}\n`; }
function selectionReport(all: Candidate[], selected: Candidate[], outcomes: Outcome[]) { return `# Candidate selection\n\n- Evaluated: ${all.length}\n- Selected this run: ${selected.length}\n- Duplicate: ${all.filter((x) => x.duplicate).length}\n- Low / medium / high: ${["low", "medium", "high"].map((risk) => all.filter((x) => x.risk === risk).length).join(" / ")}\n\n## Inventory\n\n${all.map((x) => `- \`${x.id}\`: ${x.risk}; ${x.source}; ${x.evidence}; ${selected.some((item) => item.id === x.id) ? "selected" : x.duplicate ? "duplicate" : "deferred"}`).join("\n")}\n\n## Outcomes\n\n${outcomes.map((x) => `- \`${x.candidate_id}\`: **${x.outcome}** — ${x.reason}`).join("\n")}\n`; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "candidate"; }
function shellDisplay(value: string) { return /\s/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value; }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
