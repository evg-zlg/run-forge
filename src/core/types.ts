export type FailureCategory =
  | "test_failure"
  | "typecheck_failure"
  | "build_failure"
  | "env_config_failure"
  | "dependency_failure"
  | "infra_timeout_failure"
  | "unknown_failure";

export type Confidence = "low" | "medium" | "high";

export interface TriageOptions {
  repoPath: string;
  logPath: string;
  outPath: string;
  provider: "mock" | "openai-compatible";
  model?: string;
  allowCommand?: string[];
}

export interface FailureClassification {
  category: FailureCategory;
  confidence: Confidence;
  signals: string[];
}

export interface RepoInspection {
  packageManager: "pnpm" | "npm" | "yarn" | "unknown";
  scripts: Record<string, string>;
  lockfile?: string;
  filesMentionedInLog: string[];
  guidanceFiles: string[];
}

export interface SecretMatch {
  type: string;
  line: number;
  preview: string;
}

export interface SecretScanResult {
  status: "passed" | "failed";
  matches: SecretMatch[];
}

export interface SafetyReport {
  safeLocalProfile: boolean;
  repoPath: string;
  homeAccessDetected: boolean;
  dockerSocketDetected: boolean;
  globalEnvPassthroughDetected: boolean;
  secretScan: SecretScanResult;
  workspacePolicy: {
    writeRepo: false;
    writeArtifacts: true;
    runCommands: false;
  };
  warnings: string[];
}

export interface ReviewModel {
  category: FailureCategory;
  rootCause: string;
  confidence: Confidence;
  humanDecisionNeeded: boolean;
  summary: string[];
  logExcerpts: string[];
  relevantFiles: string[];
  relevantCommands: string[];
  checked: string[];
  notChecked: string[];
  safeNextCommand?: string;
  whyCommandIsSafe: string;
  risks: string[];
  followUp: string[];
}
