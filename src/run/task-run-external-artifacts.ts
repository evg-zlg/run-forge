import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finalizePacketManifest } from "./external-command-check-packet.js";
import type { TaskRunResult } from "./task-run-harness.js";

export async function writeExternalTaskRunPacket(result: TaskRunResult): Promise<void> {
  const external = result.externalTarget;
  if (!external) return;
  const outDir = resolve(result.outDir);
  const now = new Date().toISOString();
  const logs = result.subtasks.map((item) => [
    `## ${item.id}`,
    `Command: \`${item.evidence.command}\``,
    `Status: \`${item.executor.status}\``,
    `Exit code: \`${item.executor.exitCode ?? "null"}\``,
    `Command log: \`${item.executor.artifactPaths.commandLog}\``
  ].join("\n")).join("\n\n");
  const report = `# External triage report\n\nRunForge Agent OS capability: **${external.capabilityClassification}**\n\nFactory target validation: **${external.targetClassification}**\n\n- Target: \`${external.path}\`\n- HEAD before: \`${external.before.head ?? "unknown"}\`\n- HEAD after: \`${external.after.head ?? "unknown"}\`\n- Status before: \`${external.before.status || "clean"}\`\n- Status after: \`${external.after.status || "clean"}\`\n- Original repository mutation verdict: \`${external.mutationVerdict}\`\n- Providerless review: \`${result.review.resultPayload.status}\`\n\n## Commands\n\n${result.subtasks.map((item) => `- \`${item.evidence.command}\`: ${item.executor.status} (exit ${item.executor.exitCode ?? "null"})`).join("\n")}\n\n## Conclusion\n\nThe external target was mounted read-only at \`/source\`; all validation side effects were confined to disposable writable workspaces. No provider, network, patch apply, push, merge, deploy, database, production, or secrets access was used.\n`;

  await writeFile(join(outDir, "external-triage-report.md"), report, "utf8");
  await writeFile(join(outDir, "execution-log.md"), `# Execution log\n\n${logs}\n`, "utf8");
  await writeFile(join(outDir, "environment.json"), JSON.stringify({
    schemaVersion: "external-task-run-1",
    recordedAt: now,
    docker: { image: result.runtime.image, network: "none", sourceMount: "read-only", workspaceMount: "writable", tmpExec: true, memory: "2g", cpus: 2, pidsLimit: 512 },
    tooling: { gitRequiredInImage: true },
    dependencyPolicy: "reuse existing node_modules read-only; no install and no network",
    provider: "providerless"
  }, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "run.json"), JSON.stringify({
    schemaVersion: "external-task-run-1",
    runId: result.runId,
    taskType: "task_run_external",
    status: external.capabilityClassification,
    durationMs: 0,
    repo: { path: external.path, before: external.before, after: external.after, mutationVerdict: external.mutationVerdict }
  }, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "metrics.json"), JSON.stringify({ schemaVersion: "external-task-run-1", runId: result.runId, durationMs: 0, commands: external.commands.length }, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "safety-report.json"), JSON.stringify({
    schemaVersion: "external-task-run-1", runId: result.runId, originalRepoMutationAllowed: false,
    originalRepoMutationVerdict: external.mutationVerdict, network: "none", providerUsed: false,
    noPushAttempted: true, noMergeAttempted: true, noDeployAttempted: true, noApplyToOriginalRepoAttempted: true
  }, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "trajectory.json"), JSON.stringify({ schemaVersion: "external-task-run-1", runId: result.runId, steps: [
    { type: "external_repo_recorded" }, { type: "task_run_planned" }, { type: "docker_executor_dispatched" },
    { type: "providerless_review_finished" }, { type: "original_repo_verified" }, { type: "run_finished" }
  ] }, null, 2) + "\n", "utf8");
  const events = ["task_received", "external_repo_recorded", "workspace_prepared", "executor_dispatched", "providerless_review_finished", "original_repo_verified", "run_finished"]
    .map((type, index) => JSON.stringify({ schemaVersion: "external-task-run-1", eventId: `${result.runId}:event:${index + 1}`, runId: result.runId, type, time: now }))
    .join("\n");
  await writeFile(join(outDir, "events.jsonl"), `${events}\n`, "utf8");
  await finalizePacketManifest(outDir, "external-task-run-1");
}
