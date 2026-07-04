import type {
  CliExitPolicy,
  CommandPolicy,
  CommandResult,
  ExternalCheckStatus,
  MutationVerdict
} from "./external-command-check-types.js";
import { externalCheckSchemaVersion } from "./external-command-check-types.js";
import type { WorkspaceChangeSummary } from "./external-command-check-git.js";

export function buildMetrics(input: {
  runId: string;
  durationMs: number;
  commandResults: CommandResult[];
  status: ExternalCheckStatus;
  workspaceChangeSummary: WorkspaceChangeSummary;
  originalBefore: { status: string | null };
  mutationVerdict: MutationVerdict;
}) {
  const durations = input.commandResults.map((result) => result.durationMs);
  return {
    schemaVersion: externalCheckSchemaVersion,
    runId: input.runId,
    durationMs: input.durationMs,
    commandsRequested: input.commandResults.length,
    commandsRun: input.commandResults.filter((result) => result.status !== "blocked").length,
    commandsPassed: input.commandResults.filter((result) => result.status === "passed").length,
    commandsFailed: input.commandResults.filter((result) => result.status === "failed").length,
    commandsTimedOut: input.commandResults.filter((result) => result.status === "timed_out").length,
    stdoutBytes: input.commandResults.reduce((sum, result) => sum + result.stdoutBytes, 0),
    stderrBytes: input.commandResults.reduce((sum, result) => sum + result.stderrBytes, 0),
    stdoutTruncations: input.commandResults.filter((result) => result.stdoutTruncated).length,
    stderrTruncations: input.commandResults.filter((result) => result.stderrTruncated).length,
    workspaceChanges: input.workspaceChangeSummary.counts,
    originalRepoBaselineDirty: input.originalBefore.status === null ? null : input.originalBefore.status.length > 0,
    originalRepoMutationVerdict: input.mutationVerdict,
    originalRepoMutationVerdictConfidence: input.mutationVerdict === "unknown" ? "low" : "high",
    originalRepoMutationVerdictEvidence: input.mutationVerdict === "unknown"
      ? "git head or status was unavailable before or after the run"
      : "git head and status were compared before and after the disposable workspace run",
    commandDurationMs: {
      min: durations.length > 0 ? Math.min(...durations) : 0,
      max: durations.length > 0 ? Math.max(...durations) : 0,
      total: durations.reduce((sum, duration) => sum + duration, 0)
    },
    commands: input.commandResults.map((result) => ({
      commandId: result.commandId,
      index: result.index,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    })),
    finalStatus: input.status,
    humanGateRequired: true
  };
}

export function renderSummary(input: {
  runId: string;
  status: ExternalCheckStatus;
  repoPath: string;
  workspacePath?: string;
  commandResults: CommandResult[];
  mutationVerdict: string;
  originalBefore: { status: string | null };
  workspaceChangeSummary: WorkspaceChangeSummary;
  cliExitPolicy: CliExitPolicy;
  commandPolicy: CommandPolicy;
}): string {
  const truncated = input.commandResults.some((result) => result.stdoutTruncated || result.stderrTruncated);
  return `# RunForge External Check Summary

Run ID: ${input.runId}
Status: ${input.status}
CLI exit policy: ${input.cliExitPolicy}
Command policy: on failure ${input.commandPolicy.onFailure}; final status rule ${input.commandPolicy.finalStatusRule}

Repo: ${input.repoPath}
Original repo baseline: ${baselineStatus(input.originalBefore.status)}
Original repo mutation verdict: ${input.mutationVerdict}
Workspace: ${input.workspacePath ?? "not prepared"}
Workspace diff: ${input.workspaceChangeSummary.method}, ${input.workspaceChangeSummary.status}
Workspace changes: added ${input.workspaceChangeSummary.counts.added}, modified ${input.workspaceChangeSummary.counts.modified}, deleted ${input.workspaceChangeSummary.counts.deleted}
${renderWorkspaceFiles(input.workspaceChangeSummary)}

Commands:
${input.commandResults.map(renderCommand).join("\n")}

${input.status === "timed_out" ? "Timeout next action: inspect the timed-out command logs, then rerun with a larger --timeout-ms or a narrower command if the timeout was expected." : ""}
${truncated ? "Warning: one or more command logs were truncated by --max-log-bytes. Inspect truncation flags before drawing conclusions from missing log tail content." : ""}

Dependency context:
RunForge runs commands in a disposable copied workspace. Dependency directories such as node_modules may not be copied depending on workspace copy policy, so commands that require installed dependencies should include setup/install steps or use a workspace policy that supplies them. A dependency failure is packet evidence, not original-repo mutation.

Key artifacts:
- command-results.json
- logs/
- metrics.json
- events.jsonl
- safety-report.json
- trajectory.json
- packet-manifest.json

Suggested next action:
${input.status === "passed" ? "Review summary.md and preserve this packet as evidence." : "Inspect the command stderr/stdout logs and run failure triage when ready."}
`;
}

function renderCommand(result: CommandResult): string {
  return [
    `${result.index}. ${result.command}`,
    `   commandId: ${result.commandId}`,
    `   status: ${result.status}; exitCode: ${result.exitCode ?? "null"}; signal: ${result.signal ?? "null"}; timedOut: ${result.timedOut}; duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `   stdout: ${result.stdoutPath} (${result.stdoutBytes} bytes, truncated: ${result.stdoutTruncated})`,
    `   stderr: ${result.stderrPath} (${result.stderrBytes} bytes, truncated: ${result.stderrTruncated})`
  ].join("\n");
}

function baselineStatus(status: string | null): string {
  if (status === null) return "unknown";
  return status.length === 0 ? "clean" : "dirty";
}

function renderWorkspaceFiles(summary: WorkspaceChangeSummary): string {
  const lines = [
    renderFileList("Added", summary.fileChanges.added),
    renderFileList("Modified", summary.fileChanges.modified),
    renderFileList("Deleted", summary.fileChanges.deleted)
  ].filter(Boolean);
  if (summary.status === "unknown") lines.push(`Workspace diff error: ${summary.error ?? "unknown"}`);
  return lines.length > 0 ? lines.join("\n") : "Workspace notable files: none";
}

function renderFileList(label: string, files: string[]): string {
  if (files.length === 0) return "";
  const cap = 10;
  const shown = files.slice(0, cap).join(", ");
  const suffix = files.length > cap ? `, ... (${files.length - cap} more)` : "";
  return `${label}: ${shown}${suffix}`;
}
