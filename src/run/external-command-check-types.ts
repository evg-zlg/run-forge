export type ExternalCheckStatus = "passed" | "failed" | "timed_out" | "error" | "blocked";
export type CommandStatus = "passed" | "failed" | "timed_out" | "error" | "blocked";
export type MutationVerdict = "unchanged" | "changed" | "unknown";
export type CliExitPolicy = "packet" | "command-status";

export const externalCheckSchemaVersion = "alpha-2.1";

export interface CommandPolicy {
  onFailure: "continue";
  finalStatusRule: "failed_if_any_command_failed_or_timed_out";
}

export interface ExternalCommandCheckOptions {
  repo: string;
  commands: string[];
  out?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  runId?: string;
  exitPolicy?: CliExitPolicy;
}

export interface ExternalCommandCheckResult {
  runId: string;
  status: ExternalCheckStatus;
  packetDir: string;
  repoPath: string;
  workspacePath?: string;
  cliExitPolicy: CliExitPolicy;
  cliExitCode: number;
  commandResults: CommandResult[];
  safetyReport: SafetyReport;
}

export interface CommandResult {
  commandId: string;
  index: number;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: CommandStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  blockReason?: string;
}

export interface GitSnapshot {
  head: string | null;
  status: string | null;
  error?: string;
}

export interface SafetyReport {
  schemaVersion: string;
  runId: string;
  cliExitPolicy: CliExitPolicy;
  cliExitCode: number;
  originalRepoMutationAllowed: false;
  originalRepoBefore: GitSnapshot;
  originalRepoAfter: GitSnapshot;
  originalRepoMutationVerdict: MutationVerdict;
  workspacePath?: string;
  noPushAttempted: boolean;
  noMergeAttempted: boolean;
  noApplyToOriginalRepoAttempted: boolean;
  noDeployAttempted: boolean;
  commandsUserProvidedViaCli: boolean;
  secretsHandling: {
    deliberateSecretPrinting: false;
    note: string;
  };
  dependencyContext: {
    workspacePolicy: "disposable_copy";
    note: string;
  };
  blockedCommands: Array<{ index: number; command: string; reason: string }>;
}
