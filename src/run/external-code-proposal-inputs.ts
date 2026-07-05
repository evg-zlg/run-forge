import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runExternalProposalReadiness } from "./external-proposal-readiness.js";
import type { ExternalCodeProposalOptions } from "./external-code-proposal.js";

export interface ReadinessContract {
  readinessOutcome?: string;
  canAttemptCodeProposal?: boolean;
  sourceTriagePacket?: string;
  sourceCheckPacket?: string | null;
  failureCategory?: string;
  suggestedVerificationCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  maxFilesChanged?: number;
  maxPatchBytes?: number;
}

export function validateOptions(options: ExternalCodeProposalOptions): void {
  const hasPacket = Boolean(options.fromReadinessPacket);
  const hasRepoCommand = Boolean(options.repo) || Boolean(options.commands && options.commands.length > 0);
  if (hasPacket && hasRepoCommand) throw new Error("Use either --from-readiness-packet or --repo with --command, not both.");
  if (!hasPacket && !options.repo) throw new Error("--repo is required when --from-readiness-packet is not provided.");
  if (!hasPacket && (!options.commands || options.commands.length === 0)) throw new Error("At least one --command is required when --from-readiness-packet is not provided.");
  if (options.commands?.some((command) => command.trim().length === 0)) throw new Error("--command values must be non-empty.");
}

export async function createSourceReadinessPacket(
  options: ExternalCodeProposalOptions,
  outRoot: string,
  emit: (type: string, data?: object) => string
): Promise<string> {
  const readinessOut = join(outRoot, "readiness-source");
  emit("source_readiness_started", { readinessOut });
  const result = await runExternalProposalReadiness({
    repo: options.repo,
    commands: options.commands,
    out: readinessOut,
    timeoutMs: options.timeoutMs,
    maxLogBytes: options.maxLogBytes
  });
  emit("source_readiness_finished", { readinessOut, sourceReadinessPacket: result.packetDir, readinessOutcome: result.readinessOutcome });
  return result.packetDir;
}

export async function readReadinessContract(packetDir: string): Promise<ReadinessContract> {
  await access(join(packetDir, "proposal-contract.json"));
  return JSON.parse(await readFile(join(packetDir, "proposal-contract.json"), "utf8")) as ReadinessContract;
}

export async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function defaultOutDir(): string {
  return join(process.cwd(), "artifacts", "external-code-proposal");
}
