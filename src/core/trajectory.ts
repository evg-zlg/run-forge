import { randomBytes } from "node:crypto";
import type { Confidence, FailureCategory, SafetyReport } from "./types.js";

export interface TrajectoryStep {
  name: string;
  status: "passed" | "failed";
  summary: string;
}

export function createRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

export function buildTrajectory(input: {
  runId: string;
  repoPath: string;
  logPath: string;
  steps: TrajectoryStep[];
  safety: SafetyReport;
  category: FailureCategory;
  confidence: Confidence;
  humanDecisionNeeded: boolean;
}) {
  return {
    runId: input.runId,
    mode: "local",
    command: "triage",
    inputs: {
      repoPath: input.repoPath,
      logPath: input.logPath
    },
    steps: input.steps,
    security: {
      homeMounted: input.safety.homeAccessDetected,
      dockerSocketMounted: input.safety.dockerSocketDetected,
      secretScan: input.safety.secretScan.status,
      workspaceWrites: "none"
    },
    result: {
      category: input.category,
      confidence: input.confidence,
      humanDecisionNeeded: input.humanDecisionNeeded
    }
  };
}
