import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { validateProviderPatch, type ProviderPatchContract, type ProviderPatchValidationResult } from "./provider-patch-validator.js";
import { buildProviderAudit, providerCommandHash, type ProviderAudit } from "./provider-audit.js";
import { bounded, renderInputSummary, renderOutputSummary, renderSafetyReport, renderTask } from "./provider-report-renderer.js";

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
  inputBytes: number;
  outputBytes: number;
  errors: string[];
  filesChanged: string[];
  inputSummary: string;
  outputSummary: string;
  safetyReport: Record<string, unknown>;
  providerAudit: ProviderAudit;
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
  const startedAt = new Date(started).toISOString();
  const providerInputDir = join(input.packetDir, "provider-input");
  await mkdir(providerInputDir, { recursive: true });
  const taskText = renderTask(input);
  await writeFile(join(providerInputDir, "task.md"), taskText, "utf8");
  const proposalContract = {
    patchFormat: "unified_diff_or_json_patch_field",
    mustOnlyEditRepoRelativeFiles: true,
    allowedPaths: uniqueNonEmpty(input.contract?.allowedPaths),
    forbiddenPaths: uniqueNonEmpty(input.contract?.forbiddenPaths ?? [".env", ".env.*", "**/secrets/**", "deploy/**", "infra/**"]),
    maxFilesChanged: input.contract?.maxFilesChanged ?? 3,
    maxPatchBytes: input.contract?.maxPatchBytes ?? 50_000,
    humanGateRequired: true,
    applyOriginalRepo: false
  };
  const contractText = JSON.stringify(proposalContract, null, 2);
  const evidenceText = bounded(input.failureEvidence, 8000);
  const instructionsText = [
    "Return a unified diff on stdout or write provider-output.patch.",
    "Alternatively return JSON on stdout with {\"status\":\"proposal\",\"patch\":\"diff --git ...\"}.",
    "Do not include secrets. Do not modify forbidden paths."
  ].join("\n");
  const inputBytes = [taskText, contractText, evidenceText, instructionsText]
    .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  await writeFile(join(providerInputDir, "proposal-contract.json"), contractText, "utf8");
  await writeFile(join(providerInputDir, "evidence-excerpts.md"), evidenceText, "utf8");
  await writeFile(join(providerInputDir, "instructions.md"), instructionsText, "utf8");

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
    const finishedAt = new Date(started + durationMs).toISOString();
    const outputBytes = Buffer.byteLength(rawOutput, "utf8");
    if (!validation.accepted) {
      return providerResult("rejected", patch, startedAt, finishedAt, durationMs, inputBytes, outputBytes, validation.errors, validation.filesChanged, input, validation);
    }
    const providerAudit = buildProviderAudit({
      providerCommand: input.providerCommand,
      status: "accepted",
      startedAt,
      finishedAt,
      durationMs,
      inputBytes,
      outputBytes,
      patchBytes: validation.patchBytes,
      errors: []
    });
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
      inputBytes,
      outputBytes,
      errors: [],
      filesChanged: validation.filesChanged,
      inputSummary: renderInputSummary(input),
      outputSummary: renderOutputSummary("accepted", outputBytes, validation.filesChanged, [], validation, providerAudit),
      safetyReport: renderSafetyReport("accepted", validation.filesChanged, [], validation, input, providerAudit),
      providerAudit
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const finishedAt = new Date(started + durationMs).toISOString();
    return providerResult("failed", "", startedAt, finishedAt, durationMs, inputBytes, 0, [error instanceof Error ? error.message : String(error)], [], input, null);
  }
}

function uniqueNonEmpty(values?: string[]): string[] {
  return [...new Set((values ?? []).filter(Boolean))];
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
        `Provider command hash: ${providerCommandHash(input.providerCommand)}.`,
        `Provider input bytes: ${result.inputBytes}.`,
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
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  inputBytes: number,
  outputBytes: number,
  errors: string[],
  filesChanged: string[],
  input: Parameters<typeof runCliProviderProposal>[0],
  validation: ProviderPatchValidationResult | null
): ProviderProposalResult {
  const providerAudit = buildProviderAudit({
    providerCommand: input.providerCommand,
    status,
    startedAt,
    finishedAt,
    durationMs,
    inputBytes,
    outputBytes,
    patchBytes: validation?.patchBytes ?? Buffer.byteLength(patch, "utf8"),
    errors
  });
  return {
    status,
    patch,
    proposal: null,
    durationMs,
    inputBytes,
    outputBytes,
    errors,
    filesChanged,
    inputSummary: renderInputSummary(input),
    outputSummary: renderOutputSummary(status, outputBytes, filesChanged, errors, validation, providerAudit),
    safetyReport: renderSafetyReport(status, filesChanged, errors, validation, input, providerAudit),
    providerAudit
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
