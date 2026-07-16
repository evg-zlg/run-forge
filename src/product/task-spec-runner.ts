import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runForgeRoot } from "../core/version.js";
import { runTaskRunHarness, type TaskRunResult } from "../run/task-run-harness.js";
import { runExternalExecution, type ExternalExecutionResult } from "../run/external-execution.js";
import { loadTaskSpecV2, redactedTaskSpec, type TaskSpecV2 } from "./task-spec-v2.js";
import { externalResultContract, readExternalValidationResults, validateTaskResultContract } from "./task-result-contract.js";
import { inspectProject, type ProjectInspection } from "./project-inspection.js";

export type TaskSpecExecution =
  | { kind: "validation"; spec: TaskSpecV2; result: TaskRunResult; summary: string; success: boolean }
  | { kind: "repair"; spec: TaskSpecV2; result: ExternalExecutionResult; summary: string; success: boolean };

export async function runTaskSpecFile(path: string): Promise<TaskSpecExecution> {
  const spec = await loadTaskSpecV2(path);
  const initialTarget = await inspectProject(spec.target.repository);
  await writeNormalizedSpec(spec);
  if (spec.repair.mode === "none") {
    const result = await preserveSpecOnFailure(spec, initialTarget, () => runTaskRunHarness({
      taskId: spec.taskId,
      executionRoot: runForgeRoot(),
      forceExternal: true,
      task: `${spec.task.text}\nGoal: ${spec.task.goal}\nAcceptance: ${spec.task.acceptanceCriteria.join("; ")}`,
      out: spec.artifacts.root,
      repo: spec.target.repository,
      commands: spec.validation.commands,
      runtime: "docker",
      dockerImage: spec.runtime.dockerImage,
      prepareRuntime: spec.runtime.prepareDependencies ? "explicit" : "none",
      tmpRoot: join(dirname(spec.artifacts.root), ".runforge-task-runs", spec.taskId),
      checkCommand: "node --version"
    }));
    await writeNormalizedSpec(spec);
    await finalizeValidationArtifacts(spec, result);
    return { kind: "validation", spec, result, summary: `TaskSpec ${spec.taskId}: ${result.status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: result.status === "completed" };
  }
  const result = await preserveSpecOnFailure(spec, initialTarget, () => runExternalExecution({
    taskId: spec.taskId,
    task: spec.task.text,
    out: spec.artifacts.root,
    repo: spec.target.repository,
    runtime: "docker",
    dockerImage: spec.runtime.dockerImage,
    prepareRuntime: spec.runtime.prepareDependencies ? "explicit" : "none",
    repairMode: spec.repair.mode,
    repairPlan: spec.repair.plan ?? undefined,
    existingCandidates: [],
    authority: spec.authority.envelopeFile ?? undefined,
    approvalMode: "require-owner-decision",
    applyMode: spec.git.publication === "draft-pr" ? "local-non-main-branch" : "none",
    targetBranch: spec.git.branch ?? undefined,
    publicationMode: spec.git.publication,
    commands: spec.validation.commands,
    tmpRoot: join(dirname(spec.artifacts.root), ".runforge-task-runs", spec.taskId),
    timeoutMs: 300_000
  }));
  await writeNormalizedSpec(spec);
  const status = await finalizeRepairArtifacts(spec, result);
  return { kind: "repair", spec, result, summary: `TaskSpec ${spec.taskId}: ${status}\nSummary: ${join(spec.artifacts.root, "summary.md")}\nResults: ${join(spec.artifacts.root, "results.json")}`, success: ["completed", "awaiting_owner_decision"].includes(status) };
}

async function preserveSpecOnFailure<T>(spec: TaskSpecV2, initialTarget: ProjectInspection, execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch (error) {
    await writeNormalizedSpec(spec);
    await writeFailureArtifacts(spec, initialTarget);
    throw error;
  }
}

async function writeFailureArtifacts(spec: TaskSpecV2, initialTarget: ProjectInspection): Promise<void> {
  const finalTarget = await inspectProject(spec.target.repository);
  const changed = initialTarget.head !== finalTarget.head || initialTarget.worktree.summary !== finalTarget.worktree.summary;
  const document = {
    schemaVersion: 1, contract: "runforge-task-result", taskId: spec.taskId, status: "failed",
    targetRepository: { path: spec.target.repository, initialSha: initialTarget.head, finalSha: finalTarget.head, changed },
    completedWork: [], validation: [],
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json" },
    git: { branch: null, commit: null, pullRequest: null, merge: null },
    ownerGate: { required: false, status: "not_available_failed_orchestration" },
    nextAction: { recommendation: "Inspect runtime logs under the artifact root, correct the orchestration or environment failure, then retry the identical TaskSpec." },
    safetyAssertions: { targetUnchanged: !changed, targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false },
    errors: ["TaskSpec execution stopped before normal result finalization."],
    limitations: ["Validation evidence was unavailable at failure finalization."]
  };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result\n\nStatus: **failed**\n\nExecution stopped before normal result finalization. Target main push, PR merge, deploy, DB, production, secrets, and provider calls were not performed.\n\n## Next action\n\n${document.nextAction.recommendation}\n`, "utf8");
}

async function writeNormalizedSpec(spec: TaskSpecV2): Promise<void> {
  await mkdir(spec.artifacts.root, { recursive: true });
  await writeFile(join(spec.artifacts.root, "task-spec.normalized.json"), JSON.stringify(redactedTaskSpec(spec), null, 2) + "\n", "utf8");
}

async function finalizeValidationArtifacts(spec: TaskSpecV2, result: TaskRunResult): Promise<void> {
  const resultsPath = join(spec.artifacts.root, "results.json");
  const current = JSON.parse(await readFile(resultsPath, "utf8")) as Record<string, unknown>;
  const completed = result.status === "completed";
  const normalized = {
    ...current,
    artifacts: { summary: "summary.md", results: "results.json", normalizedTaskSpec: "task-spec.normalized.json", details: { plan: "plan.md", review: "review/review.md", subtasks: "subtasks/" } },
    ownerGate: { required: false, status: "not_required" },
    nextAction: { recommendation: completed ? "Task completed. Read summary.md and preserve results.json as evidence." : "Inspect failed validation and safety evidence, resolve the cause, then start a new run." },
    limitations: completed ? [] : [...array(current.limitations), "The read-only task did not satisfy all validation and safety checks."],
    review: { ...asRecord(current.review), humanDecisionRequired: false, recommendedNextAction: completed ? "No owner decision is required for this completed read-only task." : "Inspect failures and rerun after correction; owner approval does not convert failed evidence into success." },
    recommendedNextStep: completed ? "Task completed; preserve the official result artifacts." : "Resolve failed evidence and start a new TaskSpec run.",
    recommendedNextMilestone: null
  };
  validateTaskResultContract(normalized);
  await writeFile(resultsPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  const validations = [
    ...result.subtasks.map((item) => `- \`${item.evidence.command}\`: **${item.evidence.status}** (exit ${item.evidence.exitCode}; task validation)`),
    ...result.checks.map((item) => `- \`${item.command}\`: **${item.result}** (exit ${item.exitCode}; safety check)`)
  ].join("\n");
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result

Status: **${result.status}**

## Task

${spec.task.text}

Goal: ${spec.task.goal}

## Validation

${validations}

## Target safety

- Repository: \`${spec.target.repository}\`
- Initial SHA: \`${result.sourceRepository.before?.head}\`
- Final SHA: \`${result.sourceRepository.after?.head}\`
- Target changed: **${result.sourceRepository.unchanged === false}**
- Main push, PR merge, deploy, DB, production, secrets, and provider calls: **none**

## Owner gate

Not required for this read-only task. ${completed ? "The task completed." : "The task failed and must be corrected and rerun; approval cannot override failed evidence."}

## Next action

${completed ? "Read `results.json` for the normalized machine-readable record. No continuation is required." : "Read `results.json` and the referenced logs, correct the failure, and start a new run."}
`, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

async function finalizeRepairArtifacts(spec: TaskSpecV2, result: ExternalExecutionResult): Promise<string> {
  const document: Record<string, unknown> = { ...externalResultContract({ taskId: spec.taskId, targetBranch: spec.git.branch ?? undefined }, result, spec.validation.commands), validation: await readExternalValidationResults(spec.artifacts.root, spec.validation.commands), ...result };
  validateTaskResultContract(document);
  await writeFile(join(spec.artifacts.root, "results.json"), JSON.stringify(document, null, 2) + "\n", "utf8");
  const status = String(document.status);
  const ownerGate = asRecord(document.ownerGate);
  const nextAction = asRecord(document.nextAction);
  await writeFile(join(spec.artifacts.root, "summary.md"), `# ${spec.taskId} result

Status: **${status}**

- Target: \`${spec.target.repository}\`
- Initial SHA: \`${result.source.before.head}\`
- Final SHA: \`${result.source.after.head}\`
- Target changed: **${!result.source.unchanged}**
- Owner gate: **${String(ownerGate.status)}**
- Main push / target PR merge / deploy / DB / production / secrets: **none**

## Next action

${String(nextAction.recommendation)}
`, "utf8");
  return status;
}
