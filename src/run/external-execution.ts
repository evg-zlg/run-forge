import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createExecutorRequest, DockerShellExecutor, type ExecutorResult } from "./task-run-executor.js";
import { assertExternalPathsOutsideTarget, assertExternalTaskPolicy } from "./task-run-external-target.js";
import { inspectRepoState, prepareExternalRuntime, type RepoState, type RuntimePreparationResult } from "./runtime-preparation.js";
import { taskRunSlug } from "./task-run-workspace.js";

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
  controlledApply: "applied-to-controlled-worktree" | "skipped-awaiting-owner-approval" | "validation-failed-after-apply" | "unsafe/not runnable" | "needs owner approval";
  prReadyPackage: "ready" | "not-created" | "unsafe/not runnable" | "needs owner approval";
  patchPath: string;
  controlledWorkspace: string | null;
};

type Input = {
  task: string; out: string; repo?: string; runtime: string; dockerImage: string; prepareRuntime: string;
  repairMode: string; approvalMode: string; applyMode: string; commands: string[]; tmpRoot?: string; timeoutMs: number;
};

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

  await rm(outDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "patch-package"), { recursive: true });
  await mkdir(join(outDir, "pr-ready-package"), { recursive: true });
  await writeFile(join(outDir, "execution-log.md"), `# Execution Log\n\n- ${new Date().toISOString()}: canonicalized source, output, tmp, and controlled-worktree paths.\n`, "utf8");

  const preparation = await prepareExternalRuntime({ repo, workspace: disposable, outDir, image: input.dockerImage });
  await assertSourceUnchanged(before, repo, "runtime preparation");
  await appendLog(outDir, `runtime prepared with ${preparation.dependencyCommand}; preparation network=${preparation.networkUsed}`);
  const commands = input.commands.length ? input.commands : defaultCommands;
  const executor = new DockerShellExecutor(root, input.dockerImage, true);
  const baseline = await validateStage(executor, runId, "baseline", disposable, outDir, commands, input.timeoutMs);
  await assertSourceUnchanged(before, repo, "baseline validation");
  await writeValidation(join(outDir, "patch-package", "validation-before.md"), "Baseline", baseline);

  await cp(disposable, controlled, { recursive: true, verbatimSymlinks: true });
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

  let applied: ExecutorResult[] | null = null;
  let controlledApply: ExternalExecutionResult["controlledApply"] = "skipped-awaiting-owner-approval";
  if (input.approvalMode === "simulated-owner-approved" && reviewAccepted) {
    await execFileAsync("git", ["apply", "--check", patchPath], { cwd: controlled });
    await execFileAsync("git", ["apply", patchPath], { cwd: controlled });
    applied = await validateStage(executor, runId, "after-apply", controlled, outDir, commands, input.timeoutMs);
    controlledApply = applied.every(passed) ? "applied-to-controlled-worktree" : "validation-failed-after-apply";
  }
  await writeOwnerAndApplyReports(outDir, input, controlledApply, applied, controlled, patchPath);
  const after = await inspectRepoState(repo);
  const unchanged = before.head === after.head && before.status === after.status;
  const baselinePassed = baseline.every(passed);
  const repairPassed = afterRepair.every(passed);
  const prReady = reviewAccepted && (controlledApply === "applied-to-controlled-worktree" || controlledApply === "skipped-awaiting-owner-approval");
  if (prReady) await writePrReadyPackage(outDir, repair, baseline, afterRepair, applied, controlledApply);
  const result: ExternalExecutionResult = {
    runId, outDir: relative(root, outDir), source: { before, after, unchanged }, preparation,
    runforgeCapability: unchanged && baselinePassed && repairPassed && reviewAccepted && controlledApply !== "validation-failed-after-apply" ? "passed" : "deterministic failure",
    factoryBaseline: baselinePassed ? "passed" : "deterministic failure",
    disposableRepair: repairPassed ? "patch-ready" : "validation-failed-after-repair",
    controlledApply,
    prReadyPackage: prReady ? "ready" : "not-created",
    patchPath: relative(root, patchPath), controlledWorkspace: controlledApply === "applied-to-controlled-worktree" ? controlled : null
  };
  await writeFinalArtifacts(outDir, input, result, commands, reviewAccepted);
  return result;
}

export function validateExternalExecutionModes(input: Input): void {
  if (!input.repo) throw new Error("--repair-mode requires --repo.");
  if (input.runtime !== "docker") throw new Error("External repair requires --runtime docker.");
  if (input.prepareRuntime !== "explicit") throw new Error("External repair requires --prepare-runtime explicit.");
  if (input.repairMode !== "disposable") throw new Error("--repair-mode supports only 'disposable'.");
  if (!["await-owner", "simulated-owner-approved"].includes(input.approvalMode)) throw new Error("Unsupported --approval-mode.");
  if (input.applyMode !== "controlled-worktree") throw new Error("--apply-mode supports only 'controlled-worktree'.");
}

async function validateStage(executor: DockerShellExecutor, runId: string, stage: typeof validationStages[number], cwd: string, out: string, commands: string[], timeoutMs: number): Promise<ExecutorResult[]> {
  const results: ExecutorResult[] = [];
  for (const [index, command] of commands.entries()) {
    const id = `${stage}-${index + 1}`;
    results.push(await executor.execute(createExecutorRequest({ runId, subtaskId: id, command, cwd, artifactDir: join(out, "validation", stage, id), lane: executor.lane, timeoutMs })));
  }
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
  await writeFile(join(dir, "owner-decision.md"), `# Owner Decision\n\n- Approval mode: \`${input.approvalMode}\`\n- Apply permitted: ${input.approvalMode === "simulated-owner-approved" && accepted ? "yes, controlled worktree only" : "no"}.\n`, "utf8");
}

async function writeOwnerAndApplyReports(out: string, input: Input, result: ExternalExecutionResult["controlledApply"], applied: ExecutorResult[] | null, workspace: string, patch: string): Promise<void> {
  await writeFile(join(out, "controlled-apply-report.md"), `# Controlled Apply Report\n\n- Approval: \`${input.approvalMode}\`\n- Apply mode: \`${input.applyMode}\`\n- Result: **${result}**\n- Controlled worktree: \`${workspace}\`\n- Patch: \`${patch}\`\n- Original repository target: never\n- Push/merge/deploy: none\n${applied ? `- Offline validation: ${applied.every(passed) ? "passed" : "failed"}\n` : "- Offline validation: skipped because apply did not occur.\n"}`, "utf8");
  await writeFile(join(out, "disposable-repair-report.md"), "# Disposable Repair Report\n\nA deterministic documentation-only repair was performed in the prepared disposable workspace. The original repository was not mounted or modified.\n", "utf8");
}

async function writePrReadyPackage(out: string, repair: { file: string; summary: string }, baseline: ExecutorResult[], after: ExecutorResult[], applied: ExecutorResult[] | null, apply: ExternalExecutionResult["controlledApply"]): Promise<void> {
  const dir = join(out, "pr-ready-package");
  await writeFile(join(dir, "pr-title.txt"), "Document offline validation workflow\n", "utf8");
  await writeFile(join(dir, "pr-body.md"), `## Summary\n\n- ${repair.summary}\n- Preserve the existing commands and document their offline runtime use.\n\n## Validation\n\n- Baseline: ${baseline.every(passed) ? "passed" : "failed"}\n- After repair: ${after.every(passed) ? "passed" : "failed"}\n- After controlled apply: ${applied ? (applied.every(passed) ? "passed" : "failed") : "not run; awaiting owner approval"}\n`, "utf8");
  await writeFile(join(dir, "changed-files.md"), `# Changed Files\n\n- \`${repair.file}\` — ${repair.summary}\n`, "utf8");
  await writeFile(join(dir, "validation-summary.md"), `# Validation Summary\n\nAll task execution used Docker with \`--network none\`. Baseline=${baseline.every(passed)}, after-repair=${after.every(passed)}, controlled-apply=${apply}.\n`, "utf8");
  await writeFile(join(dir, "risk-assessment.md"), "# Risk Assessment\n\nLow risk. Documentation-only change; no runtime behavior, dependencies, infrastructure, secrets, database, or production access.\n", "utf8");
  await writeFile(join(dir, "owner-next-actions.md"), "# Owner Next Actions\n\n1. Review `patch-package/patch.diff`.\n2. Create a real non-main branch/worktree.\n3. Apply and validate the patch.\n4. Commit and open a PR manually if accepted.\n", "utf8");
}

async function writeFinalArtifacts(out: string, input: Input, result: ExternalExecutionResult, commands: string[], reviewAccepted: boolean): Promise<void> {
  const environment = { node: process.version, platform: process.platform, architecture: process.arch, cwd: process.cwd(), dockerImage: input.dockerImage, runtimeNetwork: "none", preparationNetwork: "bridge" };
  const provenance = { schemaVersion: "external-execution-1", source: result.source.before, runtimePreparation: result.preparation, task: input.task, commands, providerCalls: false, createdAt: new Date().toISOString() };
  await writeFile(join(out, "environment.json"), JSON.stringify(environment, null, 2) + "\n", "utf8");
  await writeFile(join(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");
  await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(join(out, "external-execution-report.md"), `# External Execution Report\n\n- Target: \`${result.source.before.path}\`\n- Before HEAD: \`${result.source.before.head}\`\n- After HEAD: \`${result.source.after.head}\`\n- Original unchanged: **${result.source.unchanged}**\n- Runtime: Docker, network disabled during task execution\n- Providerless review: ${reviewAccepted ? "accepted" : "rejected"}\n- Controlled apply: ${result.controlledApply}\n- PR-ready package: ${result.prReadyPackage}\n`, "utf8");
  const summary = `# ${result.runId} Summary\n\n## Classifications\n\n- RunForge capability: **${result.runforgeCapability}**\n- Factory baseline: **${result.factoryBaseline}**\n- Disposable repair: **${result.disposableRepair}**\n- Controlled apply: **${result.controlledApply}**\n- PR-ready package: **${result.prReadyPackage}**\n\n## Safety\n\n- Original Factory HEAD/status unchanged: **${result.source.unchanged}**\n- Runtime network: disabled\n- Provider, DB, prod, secrets, push, merge, deploy: none\n- Patch: \`${result.patchPath}\`\n`;
  await writeFile(join(out, "summary.md"), summary, "utf8");
  const required = [
    "summary.md", "results.json", "external-execution-report.md", "runtime-preparation-report.md", "disposable-repair-report.md",
    "controlled-apply-report.md", "environment.json", "provenance.json", "execution-log.md",
    ...["patch.diff", "patch-summary.md", "validation-before.md", "validation-after.md", "providerless-review.md", "apply-instructions.md", "rollback-instructions.md", "safety-review.md", "owner-decision.md"].map((name) => `patch-package/${name}`),
    ...["pr-title.txt", "pr-body.md", "changed-files.md", "validation-summary.md", "risk-assessment.md", "owner-next-actions.md"].map((name) => `pr-ready-package/${name}`)
  ];
  const missing: string[] = [];
  for (const path of required) await access(join(out, path)).catch(() => missing.push(path));
  await writeFile(join(out, "packet-validation.json"), JSON.stringify({ schemaVersion: "external-execution-1", status: missing.length ? "failed" : "passed", requiredFiles: required, missing }, null, 2) + "\n", "utf8");
  if (missing.length) throw new Error(`External execution packet validation failed: ${missing.join(", ")}`);
  await appendLog(out, "packet validation passed: all required external-execution files were written");
}

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
