import { resolve } from "node:path";
import type { RunSpec } from "../core/types.js";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";
import { collectContextPackFiles } from "./context-pack-files.js";

export async function collectCodeProposalFiles(spec: RunSpec): Promise<string[]> {
  if (!spec.docsProposal) return [];
  if (!spec.docsProposal.include) return [...new Set([spec.docsProposal.targetFile, ...spec.docsProposal.evidenceFiles])];
  const selection = await collectContextPackFiles({
    root: resolve(spec.repoPath),
    include: spec.docsProposal.include,
    exclude: spec.docsProposal.exclude ?? [],
    limits: {
      maxBytesPerFile: 12_000,
      maxTotalFiles: 80,
      maxTotalBytes: 240_000
    }
  });
  return selection.includedFiles.map((file) => file.path);
}

export function blockedByCodeProposalScope(spec: RunSpec, files: string[]): DeterministicCodeProposal | null {
  if (!spec.docsProposal?.include) return null;
  if (files.length === 0) return emptyDocsProposal(
    spec,
    "input.include selected no files after input.exclude and default safety skips were applied."
  );
  const requiredFiles = [spec.docsProposal.targetFile, ...spec.docsProposal.evidenceFiles];
  const missing = requiredFiles.filter((file) => !files.includes(file));
  if (missing.length > 0) return emptyDocsProposal(
    spec,
    `input.include/input.exclude did not select required docs proposal file(s): ${missing.join(", ")}.`
  );
  return null;
}

function emptyDocsProposal(spec: RunSpec, reason: string): DeterministicCodeProposal {
  return {
    taskSummary: spec.goal ?? "Prepare a docs proposal.",
    filesChanged: [],
    rationale: `No patch generated: ${reason}`,
    patch: "",
    outcome: reason.includes("required docs proposal file") ? "evidence_missing" : "proposal_not_generated",
    evidenceFiles: [],
    diagnostics: [reason]
  };
}
