import { describe, expect, it } from "vitest";
import { analyzeFailure } from "../../src/run/external-failure-triage-classifier.js";
import type { ExternalFailureTriageSourceRun, FailureEvidence } from "../../src/run/external-failure-triage-types.js";

describe("external failure triage classifier", () => {
  it("classifies missing node_modules and missing package logs as dependency_missing", () => {
    const analysis = analyzeFailure(failedRun(), [
      evidence([
        "Local package.json exists, but node_modules missing.",
        "Error: Cannot find package '@acme/config'",
        "ERR_MODULE_NOT_FOUND"
      ].join("\n"))
    ]);

    expect(analysis.category).toBe("dependency_missing");
    expect(analysis.confidence).toBe("high");
    expect(analysis.readyForCodeProposal).toBe(false);
    expect(analysis.requiresMoreContext).toBe(true);
    expect(analysis.safeNextAction).toContain("Install or prepare dependencies");
  });

  it("classifies missing Node ambient types before generic TypeScript diagnostics", () => {
    const analysis = analyzeFailure(failedRun(), [
      evidence([
        "error TS2688: Cannot find type definition file for 'node'.",
        "error TS2591: Cannot find name 'process'. Try `npm i --save-dev @types/node`."
      ].join("\n"))
    ]);

    expect(analysis.category).toBe("environment_error");
    expect(analysis.confidence).toBe("high");
    expect(analysis.readyForCodeProposal).toBe(false);
    expect(analysis.probableRootCause).toContain("Node.js ambient types");
  });
});

function failedRun(): ExternalFailureTriageSourceRun {
  return { status: "failed", taskType: "external_command_check" };
}

function evidence(stderrExcerpt: string): FailureEvidence {
  return {
    commandId: "command-001",
    index: 1,
    command: "pnpm typecheck",
    status: "failed",
    exitCode: 2,
    timedOut: false,
    stdoutPath: "logs/command-001.stdout.log",
    stderrPath: "logs/command-001.stderr.log",
    stdoutExcerpt: "",
    stderrExcerpt,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}
