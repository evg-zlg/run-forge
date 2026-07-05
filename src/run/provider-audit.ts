import { createHash } from "node:crypto";

export interface ProviderAudit {
  enabled: true;
  backend: "cli";
  commandHash: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  patchBytes: number;
  accepted: boolean;
  rejected: boolean;
  rejectionReason: string | null;
  tokenUsage: null;
  estimatedCost: null;
}

export function buildProviderAudit(input: {
  providerCommand: string;
  status: "accepted" | "rejected" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  patchBytes: number;
  errors: string[];
}): ProviderAudit {
  return {
    enabled: true,
    backend: "cli",
    commandHash: providerCommandHash(input.providerCommand),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    inputBytes: input.inputBytes,
    outputBytes: input.outputBytes,
    patchBytes: input.patchBytes,
    accepted: input.status === "accepted",
    rejected: input.status === "rejected",
    rejectionReason: input.status === "accepted" ? null : input.errors.join("; "),
    tokenUsage: null,
    estimatedCost: null
  };
}

export function providerCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}
