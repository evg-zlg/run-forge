import type {
  ExternalFailureTriageSourceRun,
  FailureEvidence,
  FailureTriageAnalysis,
  FailureTriageCategory,
  FailureTriageConfidence
} from "./external-failure-triage-types.js";

export function analyzeFailure(sourceRun: ExternalFailureTriageSourceRun, evidence: FailureEvidence[]): FailureTriageAnalysis {
  if ((sourceRun.status === "passed" || sourceRun.status === "success") && evidence.every((item) => item.status === "passed")) {
    return {
      category: "no_failure_observed",
      confidence: "high",
      probableRootCause: "No failed, timed-out, blocked, or errored command is present in the check packet.",
      evidenceBasis: ["Source check packet status is passed."],
      requiresMoreContext: false,
      readyForCodeProposal: false,
      safeNextAction: "Preserve the packet as passing evidence; no failure triage action is needed."
    };
  }
  const setupPacketClassification = setupFailureClassification(sourceRun, evidence);
  if (setupPacketClassification) return setupPacketClassification;
  if (evidence.some((item) => item.timedOut || item.status === "timed_out")) {
    return classification(
      "timeout",
      "high",
      "At least one command exceeded the configured timeout.",
      evidence,
      "Inspect the timed-out command, then rerun with a narrower command or a larger timeout if the duration is expected.",
      true,
      false
    );
  }

  const combined = evidence.map((item) => `${item.command}\n${item.stdoutExcerpt}\n${item.stderrExcerpt}`).join("\n");
  const environmentSetup = environmentSetupClassification(combined, evidence);
  if (environmentSetup) return environmentSetup;

  for (const rule of classificationRules) {
    if (rule.pattern.test(combined)) {
      return classification(rule.category, rule.confidence, rule.rootCause, evidence, rule.nextAction, !rule.readyForCodeProposal, rule.readyForCodeProposal);
    }
  }

  return classification(
    "unknown_failure",
    "low",
    "The command failed, but the captured excerpts do not contain enough recognizable evidence to classify the root cause.",
    evidence,
    "Inspect the full stdout/stderr logs and rerun with more focused commands or larger log capture if needed.",
    true,
    false
  );
}

const classificationRules: Array<{
  category: FailureTriageCategory;
  confidence: FailureTriageConfidence;
  pattern: RegExp;
  rootCause: string;
  nextAction: string;
  readyForCodeProposal: boolean;
}> = [
  {
    category: "command_not_found",
    confidence: "high",
    pattern: /(command not found|not recognized as an internal|No such file or directory|ENOENT)/i,
    rootCause: "The command or executable was not available in the execution environment.",
    nextAction: "Verify the command name and ensure the required tool is installed or invoked through the package manager script.",
    readyForCodeProposal: false
  },
  {
    category: "dependency_missing",
    confidence: "high",
    pattern: /(Cannot find module (?!['"]?[./])|Module not found:.* (?!['"]?[./])|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|missing dependency|pnpm: command not found|npm: command not found)/i,
    rootCause: "The command failed because a dependency, package, or package manager was missing in the disposable workspace environment.",
    nextAction: setupNextAction(),
    readyForCodeProposal: false
  },
  {
    category: "typecheck_error",
    confidence: "high",
    pattern: /(TS\d{4}:|Type '.*' is not assignable|Property .* does not exist|tsc\b|TypeScript)/i,
    rootCause: "The logs contain TypeScript/typecheck diagnostics.",
    nextAction: "Inspect the referenced type errors and prepare a narrow code proposal only if the diagnostics identify repo source files.",
    readyForCodeProposal: true
  },
  {
    category: "test_assertion_failure",
    confidence: "high",
    pattern: /(AssertionError|expect\(.*\)|Expected .* Received|FAIL .*\.test|Test Files .*failed|Tests .*failed)/i,
    rootCause: "The logs contain test assertion failure output.",
    nextAction: "Inspect the failing assertion and affected test, then propose a minimal code or test fix if the expected behavior is clear.",
    readyForCodeProposal: true
  },
  {
    category: "lint_error",
    confidence: "medium",
    pattern: /(eslint|lint|prettier|no-unused-vars|no-explicit-any)/i,
    rootCause: "The logs contain lint or formatting diagnostics.",
    nextAction: "Inspect lint diagnostics and propose a mechanical fix when the rule and file location are clear.",
    readyForCodeProposal: true
  },
  {
    category: "configuration_error",
    confidence: "medium",
    pattern: /(config|configuration|Cannot read properties of undefined|Invalid option|Unknown option|missing required .*config)/i,
    rootCause: "The logs point to a configuration or invocation problem.",
    nextAction: "Verify the command, config file, and environment assumptions before proposing source changes.",
    readyForCodeProposal: false
  },
  {
    category: "environment_error",
    confidence: "medium",
    pattern: /(EACCES|permission denied|ECONNREFUSED|ENOTFOUND|network|database|DATABASE_URL|API_KEY|environment variable)/i,
    rootCause: "The command appears blocked by environment, permission, network, or service setup.",
    nextAction: "Document the missing environment requirement and rerun with the required local service or variable when safe.",
    readyForCodeProposal: false
  },
  {
    category: "build_error",
    confidence: "medium",
    pattern: /(build failed|Failed to compile|Compilation failed|webpack|vite|rollup|next build)/i,
    rootCause: "The logs contain build failure output.",
    nextAction: "Inspect the first concrete build diagnostic and only propose code when the failing source location is explicit.",
    readyForCodeProposal: true
  }
];

function environmentSetupClassification(combined: string, evidence: FailureEvidence[]): FailureTriageAnalysis | null {
  const missingNodeModules = /(node_modules missing|node_modules (?:is )?missing|Local package\.json exists, but node_modules missing)/i.test(combined);
  const missingNodeTypes = /(Cannot find type definition file for ['"]?node['"]?|Cannot find name ['"]?(?:process|Buffer|__dirname|__filename|require|module)['"]?|Try `?npm i --save-dev @types\/node`?)/i.test(combined);
  const missingPackage = hasMissingExternalPackage(combined);
  if (!missingNodeModules && !missingNodeTypes && !missingPackage) return null;

  const category: FailureTriageCategory = missingNodeModules || missingPackage ? "dependency_missing" : "environment_error";
  const rootCause = missingNodeModules
    ? "The disposable workspace appears to have a package manifest but missing installed dependencies."
    : missingNodeTypes
      ? "The command failed because Node.js ambient types were unavailable in the disposable workspace."
      : "The command failed because a required package or module was unavailable in the disposable workspace.";
  return classification(
    category,
    "high",
    rootCause,
    evidence,
    setupNextAction(),
    true,
    false
  );
}

function setupFailureClassification(sourceRun: ExternalFailureTriageSourceRun, evidence: FailureEvidence[]): FailureTriageAnalysis | null {
  const status = sourceRun.status ?? "";
  const setupEvidence = evidence.filter((item) => item.phase === "setup" || item.commandId.includes(":setup:"));
  if (!status.startsWith("setup_") && setupEvidence.length === 0) return null;
  const combined = setupEvidence.map((item) => `${item.command}\n${item.stdoutExcerpt}\n${item.stderrExcerpt}`).join("\n");
  const dependency = environmentSetupClassification(combined, setupEvidence);
  if (dependency) {
    return {
      ...dependency,
      probableRootCause: `Setup/preflight failed before main commands ran. ${dependency.probableRootCause}`,
      safeNextAction: "Inspect setup/preflight logs, correct the dependency preparation command, then rerun before attempting a code proposal."
    };
  }
  return classification(
    "environment_error",
    "high",
    "Setup/preflight failed before main commands ran, so the packet does not yet provide source-fix evidence.",
    setupEvidence.length > 0 ? setupEvidence : evidence,
    "Inspect setup/preflight logs, correct the setup command or disposable workspace environment, then rerun before attempting a code proposal.",
    true,
    false
  );
}

function hasMissingExternalPackage(text: string): boolean {
  if (/(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/i.test(text)) return true;
  const packagePatterns = [
    /Cannot find package ['"]([^'"]+)['"]/gi,
    /Cannot find module ['"]([^'"]+)['"]/gi,
    /Module not found:.*?['"]([^'"]+)['"]/gi
  ];
  for (const pattern of packagePatterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      if (specifier && !specifier.startsWith(".") && !specifier.startsWith("/")) return true;
    }
  }
  return false;
}

function setupNextAction(): string {
  return "Install or prepare dependencies in the disposable workspace, or provide an explicit setup command, then rerun the failing command before attempting a code proposal.";
}

function classification(
  category: FailureTriageCategory,
  confidence: FailureTriageConfidence,
  probableRootCause: string,
  evidence: FailureEvidence[],
  safeNextAction: string,
  requiresMoreContext: boolean,
  readyForCodeProposal: boolean
): FailureTriageAnalysis {
  return {
    category,
    confidence,
    probableRootCause,
    evidenceBasis: evidence.map((item) => `${item.phase === "setup" ? "Setup" : "Command"} ${item.index} (${item.status}) ${item.command}`),
    requiresMoreContext,
    readyForCodeProposal,
    safeNextAction
  };
}
