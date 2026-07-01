import { join, resolve } from "node:path";
import { writeJson, writeText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { inspectRepo } from "../triage/repo-inspector.js";
import type { RunSafetyPolicy } from "./safety-policy.js";
import { collectContextPackFiles } from "./context-pack-files.js";

export async function buildContextPack(input: {
  spec: RunSpec;
  runDir: string;
  safety: RunSafetyPolicy;
}): Promise<{ artifacts: Record<string, string>; summary: string }> {
  const contextJsonPath = join(input.runDir, "context-pack.json");
  const contextMarkdownPath = join(input.runDir, "context-pack.md");
  const repoRoot = resolve(input.spec.repoPath);
  const options = input.spec.contextPack ?? defaultContextPackOptions();
  const files = await collectContextPackFiles({
    root: repoRoot,
    include: options.include,
    exclude: options.exclude,
    limits: {
      maxBytesPerFile: options.maxBytesPerFile,
      maxTotalFiles: options.maxTotalFiles,
      maxTotalBytes: options.maxTotalBytes
    }
  });
  const repo = await inspectRepo(repoRoot, input.spec.goal ?? "");
  const contextPack = {
    schemaVersion: 1,
    taskType: input.spec.taskType,
    runId: input.spec.runId ?? null,
    repoRoot,
    includedFiles: files.includedFiles,
    fileSummaries: files.fileSummaries,
    constraints: [
      "Local-first deterministic context artifact.",
      "Read-only repository access.",
      "No network access.",
      "No provider calls.",
      "No patch application or repository writes."
    ],
    relevantCommands: relevantCommands(repo.scripts),
    artifactReferences: {
      contextPackJson: contextJsonPath,
      contextPackMarkdown: contextMarkdownPath,
      rootArtifacts: [
        "run.json",
        "review.md",
        "trajectory.json",
        "safety-report.json",
        "context-summary.json",
        "run-spec.json"
      ]
    },
    safety: {
      repoWritesAllowed: input.safety.repoWritesAllowed,
      networkAllowed: false,
      commandExecutionAllowed: input.safety.commandExecutionAllowed,
      secretHandling: "Environment variables are not read; secret-like file excerpts are redacted."
    },
    limitations: [
      ...files.limitations,
      "File summaries are deterministic excerpts and metadata, not semantic analysis.",
      "Generated without model calls or external services."
    ]
  };

  await writeJson(contextJsonPath, contextPack);
  await writeText(contextMarkdownPath, renderContextPackMarkdown(contextPack));
  return {
    artifacts: { contextPack: contextJsonPath, contextPackMarkdown: contextMarkdownPath },
    summary: "Context pack generated as deterministic local artifacts."
  };
}

function defaultContextPackOptions(): NonNullable<RunSpec["contextPack"]> {
  return {
    include: ["**/*"],
    exclude: [],
    maxBytesPerFile: 12_000,
    maxTotalFiles: 80,
    maxTotalBytes: 240_000
  };
}

function relevantCommands(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, command]) => `pnpm ${name}: ${command}`);
}

function renderContextPackMarkdown(contextPack: {
  runId: string | null;
  repoRoot: string;
  includedFiles: Array<{ path: string; bytes: number; includedBytes: number; truncated: boolean }>;
  constraints: string[];
  relevantCommands: string[];
  safety: Record<string, unknown>;
  limitations: string[];
}): string {
  return `# Context Pack

## Purpose

Deterministic local context for future proposal or agent runs.

- Run: ${contextPack.runId ?? "unassigned"}
- Root: ${contextPack.repoRoot}

## Included Files

${contextPack.includedFiles.length > 0 ? contextPack.includedFiles.map((file) => `- ${file.path} (${file.includedBytes}/${file.bytes} bytes${file.truncated ? ", truncated" : ""})`).join("\n") : "- No files included."}

## Key Constraints

${contextPack.constraints.map((constraint) => `- ${constraint}`).join("\n")}

## Relevant Commands

${contextPack.relevantCommands.length > 0 ? contextPack.relevantCommands.map((command) => `- ${command}`).join("\n") : "- No package scripts detected."}

## Safety Notes

${Object.entries(contextPack.safety).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n")}

## Limitations

${contextPack.limitations.length > 0 ? contextPack.limitations.map((limitation) => `- ${limitation}`).join("\n") : "- No limits were reached."}
`;
}
