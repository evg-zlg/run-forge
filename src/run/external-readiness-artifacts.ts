import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskRunResult } from "./task-run-harness.js";

const execFileAsync = promisify(execFile);

export async function writeExternalReadinessArtifacts(result: TaskRunResult, repoRoot: string): Promise<void> {
  const outDir = resolve(repoRoot, result.outDir);
  const before = result.sourceRepository.before;
  const after = result.sourceRepository.after;
  const environment = {
    capturedAt: new Date().toISOString(),
    runForge: { path: repoRoot, head: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim() },
    target: before,
    runtime: {
      mode: result.runtime.mode,
      image: result.preparation?.image ?? result.runtime.image,
      target: result.preparation?.target ?? null,
      preparationNetwork: result.preparation?.networkUsed ?? false,
      executionNetwork: "none"
    }
  };
  const provenance = {
    schemaVersion: "1.0",
    runId: result.runId,
    sourceBefore: before,
    sourceAfter: after,
    sourceUnchanged: result.sourceRepository.unchanged,
    dependency: result.preparation,
    executionCommands: result.subtasks.map((item) => ({
      command: item.evidence.command,
      status: item.executor.status,
      exitCode: item.executor.exitCode,
      network: item.executor.runtime.network
    }))
  };
  await writeFile(join(outDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "execution-log.md"), renderExecutionLog(result), "utf8");
  await writeFile(join(outDir, "external-execution-readiness-report.md"), renderReadinessReport(result), "utf8");
}

function renderExecutionLog(result: TaskRunResult): string {
  return `# ${result.runId} Execution Log

Preparation command log: \`${result.preparation?.commandLog ?? "not requested"}\`

${result.subtasks.map((item) => `- \`${item.evidence.command}\`: ${item.executor.status} (exit ${item.executor.exitCode}); network \`${item.executor.runtime.network}\`; log \`${item.evidence.logPath}\``).join("\n")}

Original repository unchanged: ${result.sourceRepository.unchanged ? "yes" : "no"}
`;
}

function renderReadinessReport(result: TaskRunResult): string {
  const targetPassed = result.subtasks.every((item) => item.executor.status === "passed");
  const environmentFailure = result.subtasks.some((item) => /out of memory|cannot find module|EACCES|unsupported platform|missing optional dependency/i.test(`${item.executor.stdout}\n${item.executor.stderr}`));
  const factoryClassification = targetPassed ? "passed" : environmentFailure ? "environment/setup issue" : "deterministic failure";
  const capabilityClassification = result.preparation && result.sourceRepository.unchanged && result.subtasks.some((item) => item.id === "02-test" && /RUN\s+v\d/i.test(item.executor.stdout))
    ? "passed"
    : "environment/setup issue";
  return `# ${result.runId} External Execution Readiness Report

## Classifications

- RunForge capability: \`${capabilityClassification}\`
- External target: \`${factoryClassification}\`

## Readiness Evidence

- Target: \`${result.sourceRepository.before?.path}\`
- HEAD before: \`${result.sourceRepository.before?.head}\`
- HEAD after: \`${result.sourceRepository.after?.head}\`
- Status before: ${result.sourceRepository.before?.status || "clean"}
- Status after: ${result.sourceRepository.after?.status || "clean"}
- Original repository changed: ${result.sourceRepository.unchanged ? "no" : "yes"}
- Preparation strategy: \`${result.preparation?.strategy ?? "none"}\`
- Package manager: \`${result.preparation?.packageManager ?? "not detected"}\`
- Lockfile hash: \`${result.preparation?.lockfileHash ?? "not recorded"}\`
- Preparation network used: ${result.preparation?.networkUsed ? "yes" : "no"}
- Runtime execution network: \`none\`
- Docker image: \`${result.preparation?.image.name ?? result.runtime.image}\` (${result.preparation?.image.id ?? "identity not recorded"})
- Providerless review: \`${result.review.resultPayload.status}\` via \`${result.review.resultPayload.reviewer}\`

## Validation

${result.subtasks.map((item) => `- \`${item.evidence.command}\`: ${item.executor.status} (exit ${item.executor.exitCode})`).join("\n")}

RunForge check: \`${result.checks[0]?.command}\` -> ${result.checks[0]?.result}.

## Owner Guidance

${targetPassed ? "The external repository is reproducibly runnable in the prepared offline Linux contour; no patch package is needed." : "Inspect the command logs. The environment reached offline execution, so non-environment failures can be triaged from deterministic command evidence."}

Recommended next large milestone: \`EXTERNAL-RUN-4 — Safe Disposable Repair Execution\`.
`;
}
