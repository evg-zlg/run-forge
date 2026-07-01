import type { RunSpec } from "../core/types.js";
import type { DeterministicCodeProposal } from "./code-proposal-fixtures.js";

export function renderProposal(spec: RunSpec, files: string[], proposal: DeterministicCodeProposal | null): string {
  const filesChanged = proposal?.filesChanged.map((file) => `- ${file}`).join("\n") ?? "- No files proposed for change.";
  const why = proposal?.rationale ?? "No deterministic fixture rule matched this repository and goal.";
  const outcome = proposal?.outcome ?? "no_proposal_generated";
  const evidenceFiles = proposal?.evidenceFiles && proposal.evidenceFiles.length > 0
    ? proposal.evidenceFiles.map((file) => `- ${file}`).join("\n")
    : "- No evidence files validated.";
  const diagnostics = proposal?.diagnostics && proposal.diagnostics.length > 0
    ? proposal.diagnostics.map((item) => `- ${item}`).join("\n")
    : "- No diagnostics.";
  const proposedPatch =
    proposal === null
      ? "No patch generated: no deterministic fixture or docsProposal rule matched this repository and goal. The patch artifact is intentionally empty."
      : proposal.patch.length === 0
        ? proposal.rationale
        : "A deterministic patch was written to proposal.patch for human review.";

  return `# Code Proposal

## Task Summary

${proposal?.taskSummary ?? spec.goal ?? "No goal provided."}

## Files Proposed To Change

${filesChanged}

## Outcome

${outcome}

## Validated Evidence Files

${evidenceFiles}

## Diagnostics

${diagnostics}

## Why This Patch Is Suggested

${why}

## Safety Status

- Proposal-first only.
- No direct writes to the target repository.
- Repository was not modified by RunForge.
- Artifact-only output: inspect proposal.patch and patch-summary.md.
- No auto-push.
- No auto-merge.
- Human decision required before applying any patch.

## Repo Snapshot

${files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- No files listed."}

## Proposed Patch

${proposedPatch}

## Manual Next Step

A human can inspect proposal.patch and, if acceptable, apply it manually outside RunForge.
`;
}
