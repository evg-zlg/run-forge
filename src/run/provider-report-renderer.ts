import { providerCommandHash, type ProviderAudit } from "./provider-audit.js";
import type { ProviderPatchContract, ProviderPatchValidationResult } from "./provider-patch-validator.js";

export interface ProviderReportInput {
  providerCommand: string;
  failureEvidence: string;
  verificationCommands: string[];
  failureCategory?: string;
  contract?: ProviderPatchContract | null;
}

export function renderTask(input: ProviderReportInput): string {
  return `# Provider Proposal Task

Failure category: ${input.failureCategory ?? "unknown"}

Verification commands:
${input.verificationCommands.map((command) => `- ${command}`).join("\n") || "- none"}
`;
}

export function renderInputSummary(input: ProviderReportInput): string {
  return `# Provider Input Summary

Backend: cli

Provider command hash: ${providerCommandHash(input.providerCommand)}

Failure category: ${input.failureCategory ?? "unknown"}

Evidence bytes included: ${Buffer.byteLength(bounded(input.failureEvidence, 8000), "utf8")}

Verification commands:
${input.verificationCommands.map((command) => `- ${command}`).join("\n") || "- none"}
`;
}

export function renderOutputSummary(
  status: string,
  outputBytes: number,
  filesChanged: string[],
  errors: string[],
  validation: ProviderPatchValidationResult | null,
  providerAudit: ProviderAudit
): string {
  return `# Provider Output Summary

Provider enabled: true

Backend: cli

Provider command hash: ${providerAudit.commandHash}

Status: ${status}

Input bytes: ${providerAudit.inputBytes}

Output bytes: ${outputBytes}

Files changed:
${filesChanged.length > 0 ? filesChanged.map((file) => `- ${file}`).join("\n") : "- none"}

Errors:
${errors.length > 0 ? errors.map((error) => `- ${error}`).join("\n") : "- none"}

Safety checks:
- Patch accepted: ${status === "accepted" ? "yes" : "no"}
- Allowlist result: ${validation ? (validation.checks.allowedPaths ? "passed" : "failed") : "not_run"}
- Forbidden path result: ${validation ? (validation.checks.forbiddenPaths ? "failed" : "passed") : "not_run"}
- Dry-run apply result: ${validation?.checks.dryRunApply ?? "not_run"}
- Verification result: handled by RunForge verifier after patch acceptance
`;
}

export function renderSafetyReport(
  status: string,
  filesChanged: string[],
  errors: string[],
  validation: ProviderPatchValidationResult | null,
  input: ProviderReportInput,
  providerAudit: ProviderAudit
): Record<string, unknown> {
  return {
    providerEnabled: true,
    backend: "cli",
    commandHash: providerAudit.commandHash,
    providerExplicitlyEnabled: true,
    status,
    patchAccepted: status === "accepted",
    filesChanged,
    errors,
    rejectionReason: status === "accepted" ? null : errors.join("; "),
    patchBytes: validation?.patchBytes ?? 0,
    maxPatchBytes: validation?.maxPatchBytes ?? input.contract?.maxPatchBytes ?? 50_000,
    maxFilesChanged: validation?.maxFilesChanged ?? input.contract?.maxFilesChanged ?? 3,
    allowedPaths: validation?.allowedPaths ?? input.contract?.allowedPaths ?? [],
    forbiddenPaths: validation?.forbiddenPaths ?? input.contract?.forbiddenPaths ?? [],
    allowlistResult: validation ? (validation.checks.allowedPaths ? "passed" : "failed") : "not_run",
    forbiddenPathResult: validation ? (validation.checks.forbiddenPaths ? "failed" : "passed") : "not_run",
    dryRunApplyResult: validation?.checks.dryRunApply ?? "not_run",
    verificationResult: "deferred_to_runforge_verifier",
    checks: validation?.checks ?? null,
    originalRepoMutationAllowed: false,
    humanGateRequired: true,
    providerAudit
  };
}

export function bounded(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]\n`;
}
