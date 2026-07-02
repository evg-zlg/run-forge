import { join } from "node:path";
import { writeJson, writeText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import type { TaskResult } from "./task-implementations.js";
import { buildFixtureCodeProposal } from "./code-proposal-fixtures.js";
import { renderProposal } from "./code-proposal-renderer.js";
import { blockedByCodeProposalScope, collectCodeProposalFiles } from "./code-proposal-scope.js";
import { buildContextPack } from "./context-pack.js";
import type { RunSafetyPolicy } from "./safety-policy.js";

const defaultDocsProposalTimeoutMs = 120_000;

export async function runDocsProposal(spec: RunSpec, runDir: string, safety: RunSafetyPolicy): Promise<TaskResult> {
  const timeoutMs = docsProposalTimeoutMs();
  const contextResult = await attemptDocsProposalStep(
    () => withTimeout(() => buildDocsProposalContextPack(spec, runDir, safety), timeoutMs, "context-pack")
  );
  if (!contextResult.ok) return finalizeDocsProposalRun({
    spec,
    runDir,
    files: [],
    contextArtifacts: {},
    outcome: contextResult.timedOut ? "timeout" : "proposal_failed",
    step: "context-pack",
    message: contextResult.message
  });

  const filesResult = await attemptDocsProposalStep(
    () => withTimeout(() => collectCodeProposalFiles(spec), timeoutMs, "scope-collection")
  );
  if (!filesResult.ok) return finalizeDocsProposalRun({
    spec,
    runDir,
    files: [],
    contextArtifacts: contextResult.value.artifacts,
    outcome: filesResult.timedOut ? "timeout" : "proposal_failed",
    step: "scope-collection",
    message: filesResult.message
  });

  const proposalResult = await attemptDocsProposalStep(
    () => withTimeout(
      () => Promise.resolve(blockedByCodeProposalScope(spec, filesResult.value) ?? buildFixtureCodeProposal(spec, filesResult.value)),
      timeoutMs,
      "proposal-generation"
    )
  );
  if (!proposalResult.ok) return finalizeDocsProposalRun({
    spec,
    runDir,
    files: filesResult.value,
    contextArtifacts: contextResult.value.artifacts,
    outcome: proposalResult.timedOut ? "timeout" : "proposal_failed",
    step: "proposal-generation",
    message: proposalResult.message
  });

  return finalizeDocsProposalRun({
    spec,
    runDir,
    files: filesResult.value,
    contextArtifacts: contextResult.value.artifacts,
    proposal: proposalResult.value
  });
}

async function finalizeDocsProposalRun(input: {
  spec: RunSpec;
  runDir: string;
  files: string[];
  contextArtifacts: Record<string, string>;
  proposal?: Awaited<ReturnType<typeof buildFixtureCodeProposal>>;
  outcome?: NonNullable<Awaited<ReturnType<typeof buildFixtureCodeProposal>>>["outcome"];
  step?: string;
  message?: string;
}): Promise<TaskResult> {
  const summaryPath = join(input.runDir, "patch-summary.md");
  const patchPath = join(input.runDir, "proposal.patch");
  const proposalStatusPath = join(input.runDir, "proposal-status.json");
  const fallback = input.proposal ?? {
    taskSummary: input.spec.goal ?? "Prepare a docs proposal.",
    filesChanged: [],
    rationale: `No patch generated: ${input.message ?? "proposal was not generated."}`,
    patch: "",
    outcome: input.outcome ?? "proposal_not_generated",
    evidenceFiles: [],
    diagnostics: [
      input.step ? `Step failed: ${input.step}.` : "Proposal was not generated.",
      input.message ?? "No additional diagnostic message was captured."
    ]
  };
  const outcome = fallback.outcome ?? "proposal_not_generated";
  await writeText(summaryPath, renderProposal(input.spec, input.files, fallback));
  await writeText(patchPath, fallback.patch);
  await writeJson(proposalStatusPath, {
    executionStatus: "completed",
    proposalOutcome: outcome,
    humanGate: "required",
    runStatus: "blocked",
    outcome,
    filesChanged: fallback.filesChanged,
    evidenceFiles: fallback.evidenceFiles ?? [],
    diagnostics: fallback.diagnostics ?? [],
    patchBytes: Buffer.byteLength(fallback.patch, "utf8")
  });
  const artifacts = {
    ...input.contextArtifacts,
    patchSummary: summaryPath,
    proposalPatch: patchPath,
    proposalStatus: proposalStatusPath
  };
  if (fallback.patch.length === 0) {
    return {
      status: "blocked",
      artifacts,
      summary: `${outcome}: ${fallback.rationale} No patch was written; inspect patch-summary.md before changing the target repo.`
    };
  }
  return {
    status: "blocked",
    artifacts,
    summary: "proposal_ready: Code proposal prepared as gated artifacts only; human review is required before any write."
  };
}

async function attemptDocsProposalStep<T>(
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string; timedOut: boolean }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      timedOut: error instanceof DocsProposalTimeoutError || /timed out/i.test(error instanceof Error ? error.message : String(error))
    };
  }
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, step: string): Promise<T> {
  if (timeoutMs === 0) throw new DocsProposalTimeoutError(`${step} timed out after 0ms.`);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new DocsProposalTimeoutError(`${step} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class DocsProposalTimeoutError extends Error {}

function docsProposalTimeoutMs(): number {
  const raw = process.env.RUNFORGE_DOCS_PROPOSAL_TIMEOUT_MS;
  if (raw === undefined) return defaultDocsProposalTimeoutMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultDocsProposalTimeoutMs;
}

async function buildDocsProposalContextPack(
  spec: RunSpec,
  runDir: string,
  safety: RunSafetyPolicy
): Promise<{ artifacts: Record<string, string> }> {
  if (!spec.docsProposal) return { artifacts: {} };
  const include = spec.docsProposal.include ?? [...new Set([spec.docsProposal.targetFile, ...spec.docsProposal.evidenceFiles])];
  return buildContextPack({
    spec: {
      ...spec,
      taskType: "context-pack",
      contextPack: {
        allowExternalRepo: spec.docsProposal.allowExternalRepo,
        include,
        exclude: spec.docsProposal.exclude ?? [],
        maxBytesPerFile: spec.docsProposal.maxBytesPerFile ?? 12_000,
        maxTotalFiles: 80,
        maxTotalBytes: 240_000
      }
    },
    runDir,
    safety
  });
}
