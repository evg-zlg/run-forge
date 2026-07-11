import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createExecutorRequest, DockerShellExecutor, type ExecutorResult } from "./task-run-executor.js";
import { assertExternalPathsOutsideTarget, assertExternalTaskPolicy } from "./task-run-external-target.js";
import { inspectRepoState, prepareExternalRuntime, type RepoState, type RuntimePreparationResult } from "./runtime-preparation.js";
import { taskRunSlug } from "./task-run-workspace.js";
import { evaluatePatchAuthority, loadAuthority, recordAuthorityDecision, writeAuthorityReport, type AuthorityClassification, type AuthorityDecision } from "./delegated-authority.js";

const execFileAsync = promisify(execFile);
const defaultCommands = ["npm run typecheck", "npm test", "npm run build"];
const validationStages = ["baseline", "after-repair", "after-apply"] as const;

export type ExternalExecutionResult = {
  runId: string;
  outDir: string;
  source: { before: RepoState; after: RepoState; unchanged: boolean };
  preparation: RuntimePreparationResult;
  runforgeCapability: "passed" | "deterministic failure" | "environment/setup issue" | "unsafe/not runnable" | "needs owner approval";
  factoryBaseline: "passed" | "deterministic failure" | "environment/setup issue" | "unsafe/not runnable" | "needs owner approval";
  disposableRepair: "patch-ready" | "no-safe-repair-found" | "validation-failed-after-repair" | "unsafe/not runnable" | "needs owner approval";
  ownerDecisionGate: "awaiting_owner_decision" | "approved" | "rejected" | "stale_decision" | "invalid_target" | "unsafe/not runnable";
  controlledApply: "authority-approved-controlled-apply" | "applied-to-controlled-worktree" | "skipped-awaiting-owner-approval" | "skipped-rejected" | "validation-failed-after-apply" | "unsafe/not runnable";
  prReadyPackage: "ready" | "not-created" | "unsafe/not runnable" | "needs owner approval";
  authorityEnvelope: AuthorityClassification;
  patchPath: string;
  controlledWorkspace: string | null;
};

type Input = {
  task: string; out: string; repo?: string; runtime: string; dockerImage: string; prepareRuntime: string;
  repairMode: string; approvalMode: string; applyMode: string; authority?: string; commands: string[]; tmpRoot?: string; timeoutMs: number;
};

export type OwnerDecision = {
  decision_id: string; decision: "approve" | "reject" | "continue" | "hold"; run_id: string;
  patch_package_hash: string; patch_diff_hash: string; target_mode: "controlled-worktree";
  target_branch_or_worktree: string; owner_note: string; created_at: string;
};

export type ContinuationState = { repo: string; sourceBranch: string; disposable: string; controlled: string; dockerImage: string; commands: string[]; timeoutMs: number; patchPackageHash: string; patchDiffHash: string; sourceBefore: RepoState; authorityClassification?: AuthorityClassification };

export async function runExternalExecution(input: Input): Promise<ExternalExecutionResult> {
  validateExternalExecutionModes(input);
  const root = process.cwd();
  const repo = await realpath(resolve(input.repo!));
  const outDir = resolve(root, input.out);
  const runId = basename(outDir);
  const tmpRoot = resolve(input.tmpRoot ?? join(dirname(root), ".runforge-task-runs", `${taskRunSlug(basename(root))}-${taskRunSlug(runId)}`));
  const disposable = join(tmpRoot, "prepared-workspace");
  const controlled = join(outDir, "controlled-worktree");
  await assertExternalTaskPolicy({ repo, runtime: "docker", commands: input.commands });
  await assertExternalPathsOutsideTarget(repo, [outDir, tmpRoot, disposable, controlled]);
  const before = await inspectRepoState(repo);
  const authority = await loadAuthority(input.authority, repo);
  const authorityJson = authority.envelope ? JSON.stringify(authority.envelope, null, 2) + "\n" : null;

  await rm(outDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "patch-package"), { recursive: true });
  if (authorityJson) await writeFile(join(outDir, "authority.json"), authorityJson, "utf8");
  const authorityDecisions: AuthorityDecision[] = [{ timestamp: new Date().toISOString(), authority_id: authority.envelope?.authority_id, run_id: runId, action: "validate_authority", decision: authority.classification === "accepted" ? "continue" : "stop", classification: authority.classification, reason: authority.reason, repo }];
  await recordAuthorityDecision(join(outDir, "authority-decision-log.jsonl"), authorityDecisions[0]!);
  await writeFile(join(outDir, "execution-log.md"), `# Execution Log\n\n- ${new Date().toISOString()}: canonicalized source, output, tmp, and controlled-worktree paths.\n`, "utf8");

  const preparation = await prepareExternalRuntime({ repo, workspace: disposable, outDir, image: input.dockerImage });
  await assertSourceUnchanged(before, repo, "runtime preparation");
  await appendLog(outDir, `runtime prepared with ${preparation.dependencyCommand}; preparation network=${preparation.networkUsed}`);
  const commands = input.commands.length ? input.commands : defaultCommands;
  const executor = new DockerShellExecutor(root, input.dockerImage, true);
  const baseline = await validateStage(executor, runId, "baseline", disposable, outDir, commands, input.timeoutMs);
  await assertSourceUnchanged(before, repo, "baseline validation");
  await writeValidation(join(outDir, "patch-package", "validation-before.md"), "Baseline", baseline);

  const repair = await performRepair(disposable);
  if (!repair) throw new Error("No safe deterministic repair was available for this repository.");
  const patchPath = join(outDir, "patch-package", "patch.diff");
  await createPatch(repo, disposable, repair.file, patchPath, tmpRoot);
  const patchText = await readFile(patchPath, "utf8");
  const afterRepair = await validateStage(executor, runId, "after-repair", disposable, outDir, commands, input.timeoutMs);
  await writeValidation(join(outDir, "patch-package", "validation-after.md"), "After disposable repair", afterRepair);
  await assertSourceUnchanged(before, repo, "disposable repair validation");
  const reviewAccepted = baseline.every(passed) && afterRepair.every(passed) && reviewPatchText(patchText);
  await writePatchPackage(outDir, input, repair, reviewAccepted, baseline, afterRepair);
  const patchDiffHash = await hashFile(patchPath);
  const patchPackageHash = await hashPatchPackage(join(outDir, "patch-package"));
  await writeFile(join(outDir, "patch-package", "owner-decision-template.json"), JSON.stringify(decisionTemplate(runId, patchPackageHash, patchDiffHash), null, 2) + "\n", "utf8");
  const sourceBranch = (await execFileAsync("git", ["-C", repo, "branch", "--show-current"])).stdout.trim();
  const state: ContinuationState = { repo, sourceBranch, disposable, controlled, dockerImage: input.dockerImage, commands, timeoutMs: input.timeoutMs, patchPackageHash, patchDiffHash, sourceBefore: before, authorityClassification: authority.classification };
  await writeFile(join(outDir, "continuation-state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
  const applied: ExecutorResult[] | null = null;
  const controlledApply: ExternalExecutionResult["controlledApply"] = "skipped-awaiting-owner-approval";
  await writeOwnerAndApplyReports(outDir, input, controlledApply, applied, controlled, patchPath);
  await writeFile(join(outDir, "owner-approval-report.md"), "# Owner Approval Report\n\n- Status: **awaiting_owner_decision**\n- Apply performed: no\n- See `patch-package/owner-decision-template.json` and use `task-run owner-decision`.\n", "utf8");
  const after = await inspectRepoState(repo);
  const unchanged = before.head === after.head && before.status === after.status;
  const baselinePassed = baseline.every(passed);
  const repairPassed = afterRepair.every(passed);
  const prReady = false;
  const result: ExternalExecutionResult = {
    runId, outDir: relative(root, outDir), source: { before, after, unchanged }, preparation,
    runforgeCapability: unchanged && baselinePassed && repairPassed && reviewAccepted ? "needs owner approval" : "deterministic failure",
    factoryBaseline: baselinePassed ? "passed" : "deterministic failure",
    disposableRepair: repairPassed ? "patch-ready" : "validation-failed-after-repair",
    ownerDecisionGate: "awaiting_owner_decision", controlledApply,
    prReadyPackage: "needs owner approval", authorityEnvelope: authority.classification,
    patchPath: relative(root, patchPath), controlledWorkspace: null
  };
  await writeAuthorityReport(join(outDir, "authority-report.md"), authorityDecisions);
  await writeFinalArtifacts(outDir, input, result, commands, reviewAccepted, false);
  if (!authority.envelope) return result;
  const patchAuthority = evaluatePatchAuthority(authority.envelope, { files: [repair.file], risk: "low", controlledPath: controlled, sourceRepo: repo });
  const allowed = patchAuthority.classification === "accepted" && reviewAccepted && before.status === "";
  const applyDecision: AuthorityDecision = { timestamp: new Date().toISOString(), authority_id: authority.envelope.authority_id, run_id: runId, action: "apply_to_controlled_artifact_worktree", decision: allowed ? "continue" : "stop", classification: before.status !== "" ? "stale" : patchAuthority.classification, reason: before.status !== "" ? "Source repository is dirty." : patchAuthority.reason, repo, target_mode: authority.envelope.controlled_apply.mode, risk: "low", patch_package_hash: patchPackageHash, patch_diff_hash: patchDiffHash };
  authorityDecisions.push(applyDecision);
  await recordAuthorityDecision(join(outDir, "authority-decision-log.jsonl"), applyDecision);
  await writeAuthorityReport(join(outDir, "authority-report.md"), authorityDecisions);
  if (!allowed) return result;
  const delegatedDecision: OwnerDecision = { decision_id: randomUUID(), decision: "approve", run_id: runId, patch_package_hash: patchPackageHash, patch_diff_hash: patchDiffHash, target_mode: "controlled-worktree", target_branch_or_worktree: authority.envelope.controlled_apply.branch_name, owner_note: `Delegated authority ${authority.envelope.authority_id}: ${authority.envelope.owner_note}`, created_at: new Date().toISOString() };
  await writeFile(join(outDir, "owner-decision.json"), JSON.stringify(delegatedDecision, null, 2) + "\n", "utf8");
  return continueExternalExecution({ run: outDir, timeoutMs: input.timeoutMs });
}

export function validateExternalExecutionModes(input: Input): void {
  if (!input.repo) throw new Error("--repair-mode requires --repo.");
  if (input.runtime !== "docker") throw new Error("External repair requires --runtime docker.");
  if (input.prepareRuntime !== "explicit") throw new Error("External repair requires --prepare-runtime explicit.");
  if (input.repairMode !== "disposable") throw new Error("--repair-mode supports only 'disposable'.");
  if (input.approvalMode !== "require-owner-decision") throw new Error("--approval-mode supports only 'require-owner-decision'.");
  if (input.applyMode !== "none") throw new Error("--apply-mode supports only 'none' during start.");
}

async function validateStage(executor: DockerShellExecutor, runId: string, stage: typeof validationStages[number], cwd: string, out: string, commands: string[], timeoutMs: number): Promise<ExecutorResult[]> {
  const results: ExecutorResult[] = [];
  for (const [index, command] of commands.entries()) {
    const id = `${stage}-${index + 1}`;
    results.push(await executor.execute(createExecutorRequest({ runId, subtaskId: id, command, cwd, artifactDir: join(out, "validation", stage, id), lane: executor.lane, timeoutMs })));
  }
  await writeFile(join(out, "validation", stage, "results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
  await appendLog(out, `${stage} validation completed: ${results.map((item) => item.status).join(", ")}`);
  return results;
}

async function performRepair(workspace: string): Promise<{ file: "README.md"; summary: string }> {
  const packageJson = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  if (!["typecheck", "test", "build"].every((name) => typeof packageJson.scripts?.[name] === "string")) return null as never;
  const path = join(workspace, "README.md");
  await assertRepairTargetSafe(workspace, path);
  const current = await readFile(path, "utf8");
  if (current.includes("## Offline Validation")) return null as never;
  const addition = `\n## Offline Validation\n\nAfter dependencies are prepared, the deterministic validation suite can run without runtime network access:\n\n\`\`\`bash\nnpm run typecheck\nnpm test\nnpm run build\n\`\`\`\n`;
  await writeFile(path, current.trimEnd() + "\n" + addition, "utf8");
  return { file: "README.md", summary: "Document the existing deterministic offline validation sequence." };
}

async function createPatch(repo: string, workspace: string, file: string, output: string, tmpRoot: string): Promise<void> {
  const comparison = join(tmpRoot, "patch-comparison");
  await mkdir(join(comparison, "a"), { recursive: true });
  await mkdir(join(comparison, "b"), { recursive: true });
  await cp(join(repo, file), join(comparison, "a", file));
  await cp(join(workspace, file), join(comparison, "b", file));
  let diff = "";
  let exitCode = 0;
  try {
    diff = (await execFileAsync("git", ["diff", "--no-index", "--", `a/${file}`, `b/${file}`], { cwd: comparison })).stdout;
  } catch (value) {
    const error = value as { stdout?: string; code?: number };
    diff = error.stdout ?? "";
    exitCode = error.code ?? 2;
  }
  if (exitCode !== 1 || !diff) throw new Error("Could not generate a non-empty repair patch.");
  const normalized = diff.replaceAll("a/a/", "a/").replaceAll("b/b/", "b/");
  if (!reviewPatchText(normalized)) throw new Error("Generated patch failed the providerless path/scope review.");
  await writeFile(output, normalized, "utf8");
}

export async function assertRepairTargetSafe(workspace: string, target: string): Promise<void> {
  const [canonicalWorkspace, canonicalTarget] = await Promise.all([realpath(workspace), realpath(target)]);
  const fromWorkspace = relative(canonicalWorkspace, canonicalTarget);
  if (fromWorkspace === "" || fromWorkspace === ".." || fromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Repair target escapes disposable workspace: ${target}`);
  }
}

export function reviewPatchText(patch: string): boolean {
  const files = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  return files.length === 1 && files[0]?.[1] === "README.md" && files[0]?.[2] === "README.md"
    && patch.includes("\n--- a/README.md\n+++ b/README.md\n")
    && !patch.includes("GIT binary patch");
}

async function assertSourceUnchanged(before: RepoState, repo: string, stage: string): Promise<void> {
  const current = await inspectRepoState(repo);
  if (current.head !== before.head || current.status !== before.status) throw new Error(`Blocking safety failure: external source changed during ${stage}.`);
}

const passed = (result: ExecutorResult): boolean => result.status === "passed";
const rel = (out: string, path: string): string => relative(out, path);
async function appendLog(out: string, message: string): Promise<void> { await writeFile(join(out, "execution-log.md"), `- ${new Date().toISOString()}: ${message}\n`, { flag: "a" }); }
async function writeValidation(path: string, title: string, results: ExecutorResult[]): Promise<void> {
  await writeFile(path, `# ${title}\n\n${results.map((item) => `- \`${item.subtaskId}\`: **${item.status}** (exit ${item.exitCode ?? "none"}); log \`${item.artifactPaths.commandLog}\``).join("\n")}\n`, "utf8");
}

async function writePatchPackage(out: string, input: Input, repair: { file: string; summary: string }, accepted: boolean, baseline: ExecutorResult[], after: ExecutorResult[]): Promise<void> {
  const dir = join(out, "patch-package");
  await writeFile(join(dir, "patch-summary.md"), `# Patch Summary\n\n- File: \`${repair.file}\`\n- Change: ${repair.summary}\n- Scope: documentation-only, deterministic controlled demonstration repair.\n`, "utf8");
  await writeFile(join(dir, "providerless-review.md"), `# Providerless Review\n\n- Result: **${accepted ? "accepted" : "rejected"}**\n- Provider calls: none\n- Rule: one README-only patch, with baseline and post-repair validation passing.\n`, "utf8");
  await writeFile(join(dir, "safety-review.md"), `# Safety Review\n\n- Risk: low; documentation only.\n- Runtime network: disabled for all validation.\n- Original target mounted for validation: no.\n- Baseline: ${baseline.every(passed) ? "passed" : "failed"}.\n- After repair: ${after.every(passed) ? "passed" : "failed"}.\n`, "utf8");
  await writeFile(join(dir, "apply-instructions.md"), `# Apply Instructions\n\nAfter real owner approval, create a non-main branch/worktree and run \`git apply --check patch.diff && git apply patch.diff\`. Validate before committing. Do not push automatically.\n`, "utf8");
  await writeFile(join(dir, "rollback-instructions.md"), "# Rollback Instructions\n\nBefore commit, run `git apply -R patch.diff` in the controlled worktree or delete the disposable worktree.\n", "utf8");
}

async function writeOwnerAndApplyReports(out: string, input: Input, result: ExternalExecutionResult["controlledApply"], applied: ExecutorResult[] | null, workspace: string, patch: string): Promise<void> {
  await writeFile(join(out, "controlled-apply-report.md"), `# Controlled Apply Report\n\n- Approval: \`${input.approvalMode}\`\n- Apply mode: \`${input.applyMode}\`\n- Result: **${result}**\n- Controlled worktree: \`${workspace}\`\n- Patch: \`${patch}\`\n- Original repository target: never\n- Push/merge/deploy: none\n${applied ? `- Offline validation: ${applied.every(passed) ? "passed" : "failed"}\n` : "- Offline validation: skipped because apply did not occur.\n"}`, "utf8");
  await writeFile(join(out, "disposable-repair-report.md"), "# Disposable Repair Report\n\nA deterministic documentation-only repair was performed in the prepared disposable workspace. The original repository was not mounted or modified.\n", "utf8");
}

async function writePrReadyPackage(out: string, repair: { file: string; summary: string }, baseline: ExecutorResult[], after: ExecutorResult[], applied: ExecutorResult[] | null, apply: ExternalExecutionResult["controlledApply"], branch: string): Promise<void> {
  const dir = join(out, "pr-creation-package");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pr-title.txt"), "Document offline validation workflow\n", "utf8");
  await writeFile(join(dir, "pr-body.md"), `## Summary\n\n- ${repair.summary}\n- Preserve the existing commands and document their offline runtime use.\n\n## Validation\n\n- Baseline: ${baseline.every(passed) ? "passed" : "failed"}\n- After repair: ${after.every(passed) ? "passed" : "failed"}\n- After controlled apply: ${applied ? (applied.every(passed) ? "passed" : "failed") : "not run; awaiting owner approval"}\n`, "utf8");
  await writeFile(join(dir, "changed-files.md"), `# Changed Files\n\n- \`${repair.file}\` — ${repair.summary}\n`, "utf8");
  await writeFile(join(dir, "validation-summary.md"), `# Validation Summary\n\nAll task execution used Docker with \`--network none\`. Baseline=${baseline.every(passed)}, after-repair=${after.every(passed)}, controlled-apply=${apply}.\n`, "utf8");
  await writeFile(join(dir, "risk-assessment.md"), "# Risk Assessment\n\nLow risk. Documentation-only change; no runtime behavior, dependencies, infrastructure, secrets, database, or production access.\n", "utf8");
  await writeFile(join(dir, "branch-plan.md"), `# Branch Plan\n\nOwner-selected branch: \`${branch}\`. The controlled artifact worktree proves the patch; RunForge did not create or push the real branch.\n`, "utf8");
  await writeFile(join(dir, "manual-create-pr-instructions.md"), `# Manual PR Creation\n\n1. Create \`${branch}\` from the reviewed source HEAD.\n2. Apply \`patch-package/patch.diff\`.\n3. Run the documented offline validation.\n4. Commit, push, and open the PR manually after owner review.\n`, "utf8");
  await writeFile(join(dir, "owner-next-actions.md"), "# Owner Next Actions\n\nReview the controlled-apply evidence and PR package. Only the owner may create the real branch, push, or open a PR.\n", "utf8");
}

async function writeFinalArtifacts(out: string, input: Input, result: ExternalExecutionResult, commands: string[], reviewAccepted: boolean, continued: boolean): Promise<void> {
  const environment = { node: process.version, platform: process.platform, architecture: process.arch, cwd: process.cwd(), dockerImage: input.dockerImage, runtimeNetwork: "none", preparationNetwork: "bridge" };
  const provenance = { schemaVersion: "external-execution-1", source: result.source.before, runtimePreparation: result.preparation, task: input.task, commands, providerCalls: false, createdAt: new Date().toISOString() };
  await writeFile(join(out, "environment.json"), JSON.stringify(environment, null, 2) + "\n", "utf8");
  await writeFile(join(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");
  await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(join(out, "external-execution-report.md"), `# External Execution Report\n\n- Target: \`${result.source.before.path}\`\n- Before HEAD: \`${result.source.before.head}\`\n- After HEAD: \`${result.source.after.head}\`\n- Original unchanged: **${result.source.unchanged}**\n- Runtime: Docker, network disabled during task execution\n- Providerless review: ${reviewAccepted ? "accepted" : "rejected"}\n- Controlled apply: ${result.controlledApply}\n- PR-ready package: ${result.prReadyPackage}\n`, "utf8");
  const summary = `# ${result.runId} Summary\n\n## Classifications\n\n- RunForge capability: **${result.runforgeCapability}**\n- Authority envelope: **${result.authorityEnvelope}**\n- Factory baseline: **${result.factoryBaseline}**\n- Disposable repair: **${result.disposableRepair}**\n- Controlled apply: **${result.controlledApply}**\n- PR-ready package: **${result.prReadyPackage}**\n\n## Safety\n\n- Original Factory HEAD/status unchanged: **${result.source.unchanged}**\n- Runtime network: disabled\n- Provider, DB, prod, secrets, push, merge, deploy: none\n- Patch: \`${result.patchPath}\`\n`;
  await writeFile(join(out, "summary.md"), summary, "utf8");
  const required = [
    "summary.md", "results.json", "external-execution-report.md", "runtime-preparation-report.md", "disposable-repair-report.md",
    "controlled-apply-report.md", "owner-approval-report.md", "environment.json", "provenance.json", "execution-log.md", "authority-decision-log.jsonl", "authority-report.md",
    ...(result.authorityEnvelope === "accepted" ? ["authority.json"] : []),
    ...["patch.diff", "patch-summary.md", "validation-before.md", "validation-after.md", "providerless-review.md", "apply-instructions.md", "rollback-instructions.md", "safety-review.md", "owner-decision-template.json"].map((name) => `patch-package/${name}`),
    ...(continued ? ["owner-decision.json", "owner-approval-report.md", "pr-creation-package/pr-title.txt", "pr-creation-package/pr-body.md", "pr-creation-package/branch-plan.md", "pr-creation-package/manual-create-pr-instructions.md", "pr-creation-package/changed-files.md", "pr-creation-package/validation-summary.md", "pr-creation-package/risk-assessment.md", "pr-creation-package/owner-next-actions.md"] : ["continuation-state.json"])
  ];
  const missing: string[] = [];
  for (const path of required) await access(join(out, path)).catch(() => missing.push(path));
  await writeFile(join(out, "packet-validation.json"), JSON.stringify({ schemaVersion: "external-execution-1", status: missing.length ? "failed" : "passed", requiredFiles: required, missing }, null, 2) + "\n", "utf8");
  if (missing.length) throw new Error(`External execution packet validation failed: ${missing.join(", ")}`);
  await appendLog(out, "packet validation passed: all required external-execution files were written");
}

export async function recordOwnerDecision(input: { run: string; decision: string; targetMode: string; targetBranch: string; ownerNote: string }): Promise<{ decisionId: string; path: string }> {
  const out = await realpath(resolve(input.run));
  const state = await readJson<ContinuationState>(join(out, "continuation-state.json"));
  if (!["approve", "reject", "continue", "hold"].includes(input.decision)) throw new Error("--decision must be approve, reject, continue, or hold.");
  if (input.targetMode !== "controlled-worktree") throw new Error("--target-mode supports only 'controlled-worktree'.");
  assertSafeBranch(input.targetBranch);
  if (input.targetBranch === state.sourceBranch) throw new Error("Target branch must differ from the source repository's current branch.");
  if (!input.ownerNote.trim()) throw new Error("--note must not be empty.");
  const decision: OwnerDecision = { decision_id: randomUUID(), decision: input.decision as OwnerDecision["decision"], run_id: basename(out), patch_package_hash: state.patchPackageHash, patch_diff_hash: state.patchDiffHash, target_mode: "controlled-worktree", target_branch_or_worktree: input.targetBranch, owner_note: input.ownerNote.trim(), created_at: new Date().toISOString() };
  const path = join(out, "owner-decision.json");
  await writeFile(path, JSON.stringify(decision, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await appendLog(out, `owner decision ${decision.decision_id} recorded: ${decision.decision}`);
  return { decisionId: decision.decision_id, path };
}

export async function continueExternalExecution(input: { run: string; timeoutMs: number }): Promise<ExternalExecutionResult> {
  const root = process.cwd();
  const out = await realpath(resolve(input.run));
  const runId = basename(out);
  const state = await readJson<ContinuationState>(join(out, "continuation-state.json"));
  await access(join(out, "owner-decision.json")).catch(() => { throw new Error("Owner decision is absent; apply remains blocked at awaiting_owner_decision."); });
  const decision = await readJson<OwnerDecision>(join(out, "owner-decision.json"));
  validateOwnerDecisionForContinuation(decision, state, runId);
  const currentPackageHash = await hashPatchPackage(join(out, "patch-package"));
  const currentDiffHash = await hashFile(join(out, "patch-package", "patch.diff"));
  if (currentPackageHash !== decision.patch_package_hash || currentDiffHash !== decision.patch_diff_hash) throw new Error("Stale owner decision: patch package changed after approval.");
  const currentSource = await inspectRepoState(state.repo);
  if (currentSource.head !== state.sourceBefore.head || currentSource.status !== state.sourceBefore.status) throw new Error("Source repository is dirty or changed since package preparation.");
  if (!ownerDecisionPermitsApply(decision)) {
    await appendLog(out, `continue stopped: owner decision is ${decision.decision}`);
    throw new Error(`Owner decision '${decision.decision}' does not permit apply.`);
  }
  await assertExternalPathsOutsideTarget(state.repo, [out, state.disposable, state.controlled]);
  await rm(state.controlled, { recursive: true, force: true });
  await cp(state.disposable, state.controlled, { recursive: true, verbatimSymlinks: true });
  await cp(join(state.repo, "README.md"), join(state.controlled, "README.md"));
  const patchPath = join(out, "patch-package", "patch.diff");
  await execFileAsync("git", ["apply", "--check", patchPath], { cwd: state.controlled });
  await execFileAsync("git", ["apply", patchPath], { cwd: state.controlled });
  const executor = new DockerShellExecutor(root, state.dockerImage, true);
  const applied = await validateStage(executor, runId, "after-apply", state.controlled, out, state.commands, input.timeoutMs);
  await assertSourceUnchanged(state.sourceBefore, state.repo, "controlled apply");
  const controlledApply: ExternalExecutionResult["controlledApply"] = applied.every(passed) ? (state.authorityClassification === "accepted" ? "authority-approved-controlled-apply" : "applied-to-controlled-worktree") : "validation-failed-after-apply";
  const repair = { file: "README.md", summary: "Document the existing deterministic offline validation sequence." };
  const baseline = await validationResultsFromArtifacts(out, "baseline", state.commands.length);
  const afterRepair = await validationResultsFromArtifacts(out, "after-repair", state.commands.length);
  await writePrReadyPackage(out, repair, baseline, afterRepair, applied, controlledApply, decision.target_branch_or_worktree);
  const after = await inspectRepoState(state.repo);
  const result: ExternalExecutionResult = { runId, outDir: relative(root, out), source: { before: state.sourceBefore, after, unchanged: state.sourceBefore.head === after.head && state.sourceBefore.status === after.status }, preparation: (await readJson<{ runtimePreparation: RuntimePreparationResult }>(join(out, "provenance.json"))).runtimePreparation, runforgeCapability: applied.every(passed) ? "passed" : "deterministic failure", factoryBaseline: "passed", disposableRepair: "patch-ready", ownerDecisionGate: "approved", controlledApply, prReadyPackage: applied.every(passed) ? "ready" : "not-created", authorityEnvelope: state.authorityClassification ?? "missing", patchPath: relative(root, patchPath), controlledWorkspace: state.controlled };
  await writeFile(join(out, "owner-approval-report.md"), `# Owner Approval Report\n\n- Decision ID: \`${decision.decision_id}\`\n- Decision: **${decision.decision}**\n- Target mode: \`${decision.target_mode}\`\n- Target branch: \`${decision.target_branch_or_worktree}\`\n- Package and diff hashes: verified\n- Owner note: ${decision.owner_note}\n`, "utf8");
  await writeOwnerAndApplyReports(out, { approvalMode: "require-owner-decision", applyMode: "controlled-worktree" } as Input, controlledApply, applied, state.controlled, patchPath);
  await writeFinalArtifacts(out, { task: "continued owner-approved external repair", dockerImage: state.dockerImage } as Input, result, state.commands, true, true);
  return result;
}

function decisionTemplate(runId: string, packageHash: string, diffHash: string): Omit<OwnerDecision, "decision_id" | "created_at"> & { decision_id: string; created_at: string } {
  return { decision_id: "<generated UUID>", decision: "hold", run_id: runId, patch_package_hash: packageHash, patch_diff_hash: diffHash, target_mode: "controlled-worktree", target_branch_or_worktree: "runforge/<owner-selected-branch>", owner_note: "<required owner note>", created_at: "<ISO-8601 timestamp>" };
}
function assertSafeBranch(branch: string): void { const value = branch.trim(); if (!value || ["main", "master"].includes(value.toLowerCase()) || value.includes("..") || value.startsWith("-") || value.endsWith("/") || /[~^:?*\\[\\]\\s]/.test(value)) throw new Error("Target branch must be an explicit safe non-main branch name."); }
export function ownerDecisionPermitsApply(value: OwnerDecision): boolean { return value.decision === "approve"; }
export function validateOwnerDecisionForContinuation(value: OwnerDecision, state: ContinuationState, runId: string): void { if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.decision_id) || value.run_id !== runId || !Number.isFinite(Date.parse(value.created_at)) || !value.owner_note.trim()) throw new Error("Owner decision is incomplete or references another run."); assertSafeBranch(value.target_branch_or_worktree); if (value.target_branch_or_worktree === state.sourceBranch) throw new Error("Owner decision targets the source repository's current branch."); if (value.target_mode !== "controlled-worktree") throw new Error("Owner decision target mode is invalid."); if (value.patch_package_hash !== state.patchPackageHash || value.patch_diff_hash !== state.patchDiffHash) throw new Error("Stale owner decision: packet hashes do not match continuation state."); }
async function hashFile(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function hashPatchPackage(dir: string): Promise<string> { const names = ["patch.diff", "patch-summary.md", "validation-before.md", "validation-after.md", "providerless-review.md", "apply-instructions.md", "rollback-instructions.md", "safety-review.md"]; const hash = createHash("sha256"); for (const name of names) hash.update(name).update("\0").update(await readFile(join(dir, name))).update("\0"); return hash.digest("hex"); }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function validationResultsFromArtifacts(out: string, stage: string, _count: number): Promise<ExecutorResult[]> { return readJson<ExecutorResult[]>(join(out, "validation", stage, "results.json")); }

export function renderExternalExecutionCliSummary(result: ExternalExecutionResult): string {
  return [
    `External execution ${result.runforgeCapability}: ${result.runId}`,
    `Summary: ${result.outDir}/summary.md`,
    `Patch: ${result.patchPath}`,
    `Controlled apply: ${result.controlledApply}`,
    `PR-ready package: ${result.prReadyPackage}`,
    `Original source unchanged: ${result.source.unchanged}`
  ].join("\n");
}
