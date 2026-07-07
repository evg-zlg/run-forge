import type {
  CliExitPolicy,
  CommandPolicy,
  CommandResult,
  ExternalCheckStatus,
  MutationVerdict,
  SetupPolicy
} from "./external-command-check-types.js";
import { externalCheckSchemaVersion } from "./external-command-check-types.js";
import type { WorkspaceChangeSummary } from "./external-command-check-git.js";

export function buildMetrics(input: {
  runId: string;
  durationMs: number;
  setupCommandsRequested: number;
  mainCommandsRequested: number;
  setupResults: CommandResult[];
  commandResults: CommandResult[];
  setupPolicy: SetupPolicy;
  status: ExternalCheckStatus;
  workspaceChangeSummary: WorkspaceChangeSummary;
  originalBefore: { status: string | null };
  mutationVerdict: MutationVerdict;
}) {
  const allResults = [...input.setupResults, ...input.commandResults];
  const durations = allResults.map((result) => result.durationMs);
  return {
    schemaVersion: externalCheckSchemaVersion,
    runId: input.runId,
    durationMs: input.durationMs,
    setupCommandsRequested: input.setupCommandsRequested,
    setupCommandsRun: input.setupResults.filter((result) => result.status !== "blocked").length,
    setupCommandsPassed: input.setupResults.filter((result) => result.status === "passed").length,
    setupCommandsFailed: input.setupResults.filter((result) => result.status === "failed").length,
    setupCommandsTimedOut: input.setupResults.filter((result) => result.status === "timed_out").length,
    setupDurationMs: input.setupResults.reduce((sum, result) => sum + result.durationMs, 0),
    setupPolicy: input.setupPolicy,
    setupNetworkIntent: input.setupPolicy.networkIntent,
    continueAfterSetupFailure: input.setupPolicy.continueAfterSetupFailure,
    mainCommandsSkippedOnSetupFailure: input.setupPolicy.mainCommandsSkippedOnSetupFailure,
    commandsRequested: input.mainCommandsRequested,
    commandsRun: input.commandResults.filter((result) => result.status !== "blocked").length,
    commandsPassed: input.commandResults.filter((result) => result.status === "passed").length,
    commandsFailed: input.commandResults.filter((result) => result.status === "failed").length,
    commandsTimedOut: input.commandResults.filter((result) => result.status === "timed_out").length,
    stdoutBytes: allResults.reduce((sum, result) => sum + result.stdoutBytes, 0),
    stderrBytes: allResults.reduce((sum, result) => sum + result.stderrBytes, 0),
    stdoutTruncations: allResults.filter((result) => result.stdoutTruncated).length,
    stderrTruncations: allResults.filter((result) => result.stderrTruncated).length,
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
    commands: allResults.map((result) => ({
      commandId: result.commandId,
      phase: result.phase,
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
  setupResults: CommandResult[];
  commandResults: CommandResult[];
  mutationVerdict: string;
  originalBefore: { status: string | null };
  workspaceChangeSummary: WorkspaceChangeSummary;
  cliExitPolicy: CliExitPolicy;
  commandPolicy: CommandPolicy;
  setupPolicy: SetupPolicy;
}): string {
  const allResults = [...input.setupResults, ...input.commandResults];
  const truncated = allResults.some((result) => result.stdoutTruncated || result.stderrTruncated);
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

Setup policy:
- Network intent: ${input.setupPolicy.networkIntent}
- Continue after setup failure: ${input.setupPolicy.continueAfterSetupFailure ? "yes" : "no"}
- Main commands skipped on setup failure: ${input.setupPolicy.mainCommandsSkippedOnSetupFailure ? "yes" : "no"}

Setup:
${input.setupResults.length > 0 ? input.setupResults.map(renderCommand).join("\n") : "No setup commands requested."}

Commands:
${input.commandResults.length > 0 ? input.commandResults.map(renderCommand).join("\n") : "Main commands skipped."}

${input.status === "setup_failed" ? "Setup next action: inspect setup stdout/stderr logs, adjust dependency preparation or setup command, then rerun before attempting a code proposal." : ""}
${input.status === "setup_timed_out" ? "Setup timeout next action: inspect setup logs, then rerun with a larger --timeout-ms or narrower setup command if the duration was expected." : ""}
${input.status.startsWith("setup_failed_main_") ? "Diagnostic mode: main commands ran despite setup failure.\nOperator caution: do not treat this as a clean verification environment." : ""}
${input.status === "timed_out" ? "Timeout next action: inspect the timed-out command logs, then rerun with a larger --timeout-ms or a narrower command if the timeout was expected." : ""}
${truncated ? "Warning: one or more command logs were truncated by --max-log-bytes. Inspect truncation flags before drawing conclusions from missing log tail content." : ""}

Dependency context:
RunForge runs commands in a disposable copied workspace. Dependency directories such as node_modules may not be copied depending on workspace copy policy, so commands that require installed dependencies should include setup/install steps or use a workspace policy that supplies them. A dependency failure is packet evidence, not original-repo mutation.

Key artifacts:
- command-results.json
- setup-results.json
- logs/
- metrics.json
- events.jsonl
- safety-report.json
- trajectory.json
- packet-manifest.json

Suggested next action:
${suggestedNextAction(input.status)}
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

function suggestedNextAction(status: ExternalCheckStatus): string {
  if (status === "passed") return "Review summary.md and preserve this packet as evidence.";
  if (status === "setup_failed" || status === "setup_timed_out" || status === "setup_error") {
    return "Inspect the setup logs and rerun with corrected setup/preflight commands before failure triage or proposal work.";
  }
  if (status === "setup_failed_main_passed" || status === "setup_failed_main_failed") {
    return "Fix setup/preflight first, then rerun a clean verification; diagnostic main-command logs are supporting evidence only.";
  }
  return "Inspect the command stderr/stdout logs and run failure triage when ready.";
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
