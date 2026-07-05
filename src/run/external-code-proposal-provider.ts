import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { validateProviderPatch, type ProviderPatchContract, type ProviderPatchValidationResult } from "./provider-patch-validator.js";

const execAsync = promisify(exec);

export interface ProviderProposalOptions {
  enabled?: boolean;
  provider?: "cli";
  providerCommand?: string;
}

export interface ProviderProposalResult {
  status: "accepted" | "rejected" | "failed" | "disabled";
  patch: string;
  proposal: DeterministicCodeProposal | null;
  durationMs: number;
  outputBytes: number;
  errors: string[];
  filesChanged: string[];
  inputSummary: string;
  outputSummary: string;
  safetyReport: Record<string, unknown>;
}

export type ProviderWorkerRunner = <T>(
  workerRole: string,
  body: (workerId: string) => Promise<{ status: string; lines: string[]; output: T }>
) => Promise<T>;

export function validateProviderOptions(options: ProviderProposalOptions): void {
  if (!options.enabled) {
    if (options.provider || options.providerCommand) throw new Error("--provider and --provider-command require --enable-provider-proposal.");
    return;
  }
  if (options.provider !== "cli") throw new Error("--enable-provider-proposal requires --provider cli.");
  if (!options.providerCommand?.trim()) throw new Error("--enable-provider-proposal requires --provider-command.");
}

export async function runCliProviderProposal(input: {
  providerCommand: string;
  packetDir: string;
  repoPath: string;
  failureEvidence: string;
  verificationCommands: string[];
  failureCategory?: string;
  contract?: ProviderPatchContract | null;
}): Promise<ProviderProposalResult> {
  const started = Date.now();
  const providerInputDir = join(input.packetDir, "provider-input");
  await mkdir(providerInputDir, { recursive: true });
  await writeFile(join(providerInputDir, "task.md"), renderTask(input), "utf8");
  const proposalContract = {
    patchFormat: "unified_diff_or_json_patch_field",
    mustOnlyEditRepoRelativeFiles: true,
    allowedPaths: input.contract?.allowedPaths ?? [],
    forbiddenPaths: input.contract?.forbiddenPaths ?? [".env", ".env.*", "**/secrets/**", "deploy/**", "infra/**"],
    maxFilesChanged: input.contract?.maxFilesChanged ?? 3,
    maxPatchBytes: input.contract?.maxPatchBytes ?? 50_000,
    humanGateRequired: true,
    applyOriginalRepo: false
  };
  await writeFile(join(providerInputDir, "proposal-contract.json"), JSON.stringify(proposalContract, null, 2), "utf8");
  await writeFile(join(providerInputDir, "evidence-excerpts.md"), bounded(input.failureEvidence, 8000), "utf8");
  await writeFile(join(providerInputDir, "instructions.md"), [
    "Return a unified diff on stdout or write provider-output.patch.",
    "Alternatively return JSON on stdout with {\"status\":\"proposal\",\"patch\":\"diff --git ...\"}.",
    "Do not include secrets. Do not modify forbidden paths."
  ].join("\n"), "utf8");

  try {
    const result = await execAsync(input.providerCommand, {
      cwd: providerInputDir,
      env: { ...process.env, RUNFORGE_PROVIDER_INPUT: providerInputDir, RUNFORGE_PROVIDER_REPO: input.repoPath },
      maxBuffer: 1024 * 1024
    });
    const rawOutput = await providerOutput(providerInputDir, result.stdout);
    const patch = extractPatch(rawOutput);
    const validation = await validateProviderPatch({ patch, repoPath: input.repoPath, contract: input.contract });
    const durationMs = Date.now() - started;
    const outputBytes = Buffer.byteLength(rawOutput, "utf8");
    if (!validation.accepted) {
      return providerResult("rejected", patch, durationMs, outputBytes, validation.errors, validation.filesChanged, input, validation);
    }
    return {
      status: "accepted",
      patch,
      proposal: {
        taskSummary: "Provider-backed proposal from explicit CLI provider.",
        filesChanged: validation.filesChanged,
        rationale: "An explicitly enabled CLI provider returned a scoped unified diff accepted by RunForge safety checks.",
        patch,
        strategy: "provider_cli",
        evidenceSummary: ["Provider mode was explicitly enabled.", "Patch scope passed RunForge provider safety validation."]
      },
      durationMs,
      outputBytes,
      errors: [],
      filesChanged: validation.filesChanged,
      inputSummary: renderInputSummary(input),
      outputSummary: renderOutputSummary("accepted", outputBytes, validation.filesChanged, [], validation, input),
      safetyReport: renderSafetyReport("accepted", validation.filesChanged, [], validation, input)
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    return providerResult("failed", "", durationMs, 0, [error instanceof Error ? error.message : String(error)], [], input, null);
  }
}

export async function runProviderProposalWorkers(input: {
  runWorker: ProviderWorkerRunner;
  providerCommand: string;
  packetDir: string;
  repoPath: string;
  failureEvidence: string;
  verificationCommands: string[];
  failureCategory?: string;
  provider?: "cli";
  contract?: ProviderPatchContract | null;
}): Promise<ProviderProposalResult> {
  await input.runWorker("provider_input_builder", async () => ({
    status: "provider_input_prepared",
    lines: [
      "Provider proposal mode was explicitly enabled.",
      "Provider input is bounded to task, contract, failure evidence excerpts, and verification commands.",
      "Original repository mutation remains forbidden."
    ],
    output: null
  }));
  const providerResult = await input.runWorker("provider_runner", async () => {
    const result = await runCliProviderProposal(input);
    return {
      status: result.status,
      lines: [
        `Backend: ${input.provider}.`,
        `Provider command: ${input.providerCommand}.`,
        `Provider output bytes: ${result.outputBytes}.`,
        `Provider status: ${result.status}.`,
        `Files changed: ${result.filesChanged.length ? result.filesChanged.join(", ") : "none"}.`,
        ...result.errors.map((error) => `Error: ${error}`)
      ],
      output: result
    };
  });
  await input.runWorker("provider_patch_validator", async () => ({
    status: providerResult.status === "accepted" ? "patch_validated" : "patch_rejected",
    lines: [
      `Patch bytes: ${Buffer.byteLength(providerResult.patch, "utf8")}.`,
      `Files changed: ${providerResult.filesChanged.length ? providerResult.filesChanged.join(", ") : "none"}.`,
      `Allowlist result: ${String((providerResult.safetyReport.allowlistResult as string | undefined) ?? "unknown")}.`,
      `Dry-run apply result: ${String((providerResult.safetyReport.dryRunApplyResult as string | undefined) ?? "unknown")}.`,
      ...providerResult.errors.map((error) => `Validation error: ${error}`)
    ],
    output: null
  }));
  await input.runWorker("provider_safety_reviewer", async () => ({
    status: providerResult.status === "accepted" ? "accepted" : providerResult.status,
    lines: [
      "Original repository apply: forbidden.",
      "Forbidden paths and repo-relative scope checked before workspace apply.",
      `Provider accepted: ${providerResult.status === "accepted"}.`
    ],
    output: null
  }));
  return providerResult;
}

function providerResult(
  status: "rejected" | "failed",
  patch: string,
  durationMs: number,
  outputBytes: number,
  errors: string[],
  filesChanged: string[],
  input: Parameters<typeof runCliProviderProposal>[0],
  validation: ProviderPatchValidationResult | null
): ProviderProposalResult {
  return {
    status,
    patch,
    proposal: null,
    durationMs,
    outputBytes,
    errors,
    filesChanged,
    inputSummary: renderInputSummary(input),
    outputSummary: renderOutputSummary(status, outputBytes, filesChanged, errors, validation, input),
    safetyReport: renderSafetyReport(status, filesChanged, errors, validation, input)
  };
}

async function providerOutput(providerInputDir: string, stdout: string): Promise<string> {
  try {
    const filePatch = await readFile(join(providerInputDir, "provider-output.patch"), "utf8");
    if (filePatch.trim()) return filePatch;
  } catch {
    // stdout is the portable default.
  }
  return stdout;
}

function extractPatch(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { patch?: unknown };
      return typeof parsed.patch === "string" ? parsed.patch : "";
    } catch {
      return "";
    }
  }
  return output;
}

function renderTask(input: Parameters<typeof runCliProviderProposal>[0]): string {
  return `# Provider Proposal Task

Failure category: ${input.failureCategory ?? "unknown"}

Repository: ${input.repoPath}

Verification commands:
${input.verificationCommands.map((command) => `- ${command}`).join("\n") || "- none"}
`;
}

function renderInputSummary(input: Parameters<typeof runCliProviderProposal>[0]): string {
  return `# Provider Input Summary

Backend: cli

Provider command: ${input.providerCommand}

Failure category: ${input.failureCategory ?? "unknown"}

Evidence bytes included: ${Buffer.byteLength(bounded(input.failureEvidence, 8000), "utf8")}

Verification commands:
${input.verificationCommands.map((command) => `- ${command}`).join("\n") || "- none"}
`;
}

function renderOutputSummary(
  status: string,
  outputBytes: number,
  filesChanged: string[],
  errors: string[],
  validation: ProviderPatchValidationResult | null,
  input: Parameters<typeof runCliProviderProposal>[0]
): string {
  return `# Provider Output Summary

Provider enabled: true

Backend: cli

Provider command: ${input.providerCommand}

Status: ${status}

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

function renderSafetyReport(
  status: string,
  filesChanged: string[],
  errors: string[],
  validation: ProviderPatchValidationResult | null,
  input: Parameters<typeof runCliProviderProposal>[0]
): Record<string, unknown> {
  return {
    providerEnabled: true,
    backend: "cli",
    providerCommand: input.providerCommand,
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
    humanGateRequired: true
  };
}

function bounded(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]\n`;
}
