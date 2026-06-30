import type { SafetyReport, SecretScanResult } from "./types.js";
import { dockerSocketDetected } from "../security/docker-policy.js";
import { detectsHomeAccess, defaultWorkspacePolicy } from "../security/workspace-policy.js";

export function buildSafetyReport(repoPath: string, secretScan: SecretScanResult): SafetyReport {
  const warnings: string[] = [];
  if (secretScan.status === "failed") warnings.push("Secret-like values were detected and report generation was blocked.");
  if (dockerSocketDetected()) warnings.push("Docker socket is visible in this environment.");
  return {
    safeLocalProfile: secretScan.status === "passed",
    repoPath,
    homeAccessDetected: detectsHomeAccess(repoPath),
    dockerSocketDetected: dockerSocketDetected(),
    globalEnvPassthroughDetected: false,
    secretScan,
    workspacePolicy: defaultWorkspacePolicy(),
    warnings
  };
}
