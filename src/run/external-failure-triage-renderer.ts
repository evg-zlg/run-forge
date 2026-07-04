import type {
  ExternalFailureTriageSourceRun,
  FailureEvidence,
  FailureTriageAnalysis,
  FailureTriageStatus
} from "./external-failure-triage-types.js";

export function renderSummary(input: {
  runId: string;
  status: FailureTriageStatus;
  sourceRun: ExternalFailureTriageSourceRun;
  sourceCheckPacket: string;
  analysis: FailureTriageAnalysis;
  evidence: FailureEvidence[];
}): string {
  return `# RunForge External Failure Triage Summary

Run ID: ${input.runId}
Status: ${input.status}
Category: ${input.analysis.category}
Confidence: ${input.analysis.confidence}

Source check packet: ${input.sourceCheckPacket}
Source check status: ${input.sourceRun.status ?? "unknown"}
Commands analyzed: ${input.evidence.length}

Probable root cause:
${input.analysis.probableRootCause}

Ready for code proposal: ${input.analysis.readyForCodeProposal}
Requires more context: ${input.analysis.requiresMoreContext}

Safe next action:
${input.analysis.safeNextAction}

Key artifacts:
- failure-triage.md
- root-cause.json
- evidence-excerpts.md
- safe-next-action.md
- run.json
- events.jsonl
- metrics.json
- safety-report.json
- trajectory.json
`;
}

export function renderHumanReview(input: { sourceRun: ExternalFailureTriageSourceRun; analysis: FailureTriageAnalysis }): string {
  return `# Human Review

Decision needed: review triage evidence before authorizing any code proposal.

Failure category: ${input.analysis.category}
Confidence: ${input.analysis.confidence}
Source check status: ${input.sourceRun.status ?? "unknown"}

Root cause claim:
${input.analysis.probableRootCause}

Safe next action:
${input.analysis.safeNextAction}
`;
}

export function renderFailureTriage(input: {
  sourceCheckPacket: string;
  sourceRun: ExternalFailureTriageSourceRun;
  analysis: FailureTriageAnalysis;
  evidence: FailureEvidence[];
}): string {
  return `# Failure Triage

Selected route: external_failure_triage
Source packet: ${input.sourceCheckPacket}
Source task: ${input.sourceRun.taskType ?? "unknown"}
Source status: ${input.sourceRun.status ?? "unknown"}

Likely category: ${input.analysis.category}
Confidence: ${input.analysis.confidence}

Evidence basis:
${input.analysis.evidenceBasis.map((line) => `- ${line}`).join("\n")}

Probable root cause:
${input.analysis.probableRootCause}

Readiness:
- More context required: ${input.analysis.requiresMoreContext}
- Ready for code proposal: ${input.analysis.readyForCodeProposal}

Safe next action:
${input.analysis.safeNextAction}

Commands:
${input.evidence.map(renderEvidenceSummary).join("\n\n")}
`;
}

export function renderEvidence(evidence: FailureEvidence[]): string {
  return `# Evidence Excerpts

${evidence.map((item) => `## Command ${item.index}: ${item.command}

Status: ${item.status}
Exit code: ${item.exitCode ?? "null"}
Timed out: ${item.timedOut}
Stdout source: ${item.stdoutPath} (truncated: ${item.stdoutTruncated})
Stderr source: ${item.stderrPath} (truncated: ${item.stderrTruncated})

### stdout

\`\`\`text
${item.stdoutExcerpt || "[empty]"}
\`\`\`

### stderr

\`\`\`text
${item.stderrExcerpt || "[empty]"}
\`\`\`
`).join("\n")}`;
}

function renderEvidenceSummary(item: FailureEvidence): string {
  const stdoutLine = firstNonEmptyLine(item.stdoutExcerpt);
  const stderrLine = firstNonEmptyLine(item.stderrExcerpt);
  return [
    `${item.index}. ${item.command}`,
    `   status: ${item.status}; exitCode: ${item.exitCode ?? "null"}; timedOut: ${item.timedOut}`,
    `   stdout excerpt: ${stdoutLine || "[empty]"}`,
    `   stderr excerpt: ${stderrLine || "[empty]"}`
  ].join("\n");
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 240) ?? "";
}
