import type { CommandResult } from "./external-command-check-types.js";
import type { SetupNetworkIntent, SetupPolicy } from "./external-command-check-types.js";

export const externalFailureTriageSchemaVersion = "alpha-3a";

export type FailureTriageCategory =
  | "dependency_missing"
  | "typecheck_error"
  | "test_assertion_failure"
  | "lint_error"
  | "build_error"
  | "timeout"
  | "command_not_found"
  | "configuration_error"
  | "environment_error"
  | "unknown_failure"
  | "no_failure_observed";

export type FailureTriageConfidence = "high" | "medium" | "low";
export type FailureTriageStatus = "triaged" | "no_failure_observed" | "needs_more_context";

export interface ExternalFailureTriageOptions {
  fromCheckPacket?: string;
  repo?: string;
  setupCommands?: string[];
  setupNetworkIntent?: SetupNetworkIntent;
  continueAfterSetupFailure?: boolean;
  commands?: string[];
  out?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  runId?: string;
}

export interface FailureEvidence {
  commandId: string;
  phase?: CommandResult["phase"];
  index: number;
  command: string;
  status: CommandResult["status"];
  exitCode: number | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ExternalFailureTriageSourceRun {
  schemaVersion?: string;
  runId?: string;
  taskType?: string;
  status?: string;
  setupPolicy?: SetupPolicy;
  repo?: { path?: string };
  commands?: CommandResult[];
}

export interface FailureTriageAnalysis {
  category: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  probableRootCause: string;
  evidenceBasis: string[];
  requiresMoreContext: boolean;
  readyForCodeProposal: boolean;
  safeNextAction: string;
}

export interface ExternalFailureTriageResult {
  runId: string;
  status: FailureTriageStatus;
  category: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  packetDir: string;
  sourceCheckPacket: string;
  sourceCheckStatus: string;
  readyForCodeProposal: boolean;
  requiresMoreContext: boolean;
  safeNextAction: string;
}
