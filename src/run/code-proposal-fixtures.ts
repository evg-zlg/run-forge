import { readText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface DeterministicCodeProposal {
  taskSummary: string;
  filesChanged: string[];
  rationale: string;
  patch: string;
  outcome?: "proposal_ready" | "proposal_not_generated" | "no_proposal_generated" | "evidence_missing" | "proposal_failed" | "timeout" | "interrupted" | "invalid_spec";
  evidenceFiles?: string[];
  diagnostics?: string[];
}

export async function buildFixtureCodeProposal(spec: RunSpec, scopedFiles?: string[]): Promise<DeterministicCodeProposal | null> {
  assertExternalCodeProposalAllowed(spec);
  const docsProposal = await buildDocsProposal(spec, scopedFiles);
  if (docsProposal) return docsProposal;

  const testPath = "tests/calculator.test.ts";
  const testText = await readOptionalRepoFile(spec.repoPath, testPath);
  if (!testText) return null;
  if (!testText.includes("expect(add(1, 1)).toBe(3);")) return null;

  return {
    taskSummary: spec.goal ?? "Fix the sample-js calculator assertion.",
    filesChanged: [testPath],
    rationale: "The fixture's add function returns the arithmetic sum, so the assertion should expect 2 for add(1, 1).",
    patch: renderCalculatorAssertionPatch()
  };
}

async function buildDocsProposal(spec: RunSpec, scopedFiles?: string[]): Promise<DeterministicCodeProposal | null> {
  if (!spec.docsProposal) return null;
  const evidenceState = await validateDocsProposalEvidence(spec, scopedFiles);
  if (evidenceState.errors.length > 0) {
    return noDocsPatch(spec, `evidence_missing: ${evidenceState.errors.join(" ")}`, {
      outcome: "evidence_missing",
      evidenceFiles: evidenceState.included,
      diagnostics: evidenceState.errors
    });
  }
  const source = await readOptionalRepoFile(spec.repoPath, spec.docsProposal.targetFile);
  if (source === null) {
    return noDocsPatch(spec, `${spec.docsProposal.targetFile} was not found.`);
  }
  if (source.includes(spec.docsProposal.insertedText.trim())) {
    return noDocsPatch(spec, `${spec.docsProposal.targetFile} already contains the requested text.`);
  }
  const anchorIndex = source.indexOf(spec.docsProposal.anchorText);
  if (anchorIndex < 0) {
    return noDocsPatch(spec, `anchor text was not found in ${spec.docsProposal.targetFile}.`);
  }

  const insertAt = anchorIndex + spec.docsProposal.anchorText.length;
  const nextSource = `${source.slice(0, insertAt)}${normalizeInsertedText(spec.docsProposal.insertedText)}${source.slice(insertAt)}`;
  return {
    taskSummary: spec.goal ?? "Prepare a docs proposal.",
    filesChanged: [spec.docsProposal.targetFile],
    rationale: spec.docsProposal.rationale,
    patch: renderUnifiedDiff(spec.docsProposal.targetFile, source, nextSource),
    outcome: "proposal_ready",
    evidenceFiles: evidenceState.included
  };
}

function assertExternalCodeProposalAllowed(spec: RunSpec): void {
  const root = resolve(process.cwd());
  const target = resolve(spec.repoPath);
  const rel = relative(root, target);
  if (!spec.allowExternalRepo && !spec.docsProposal?.allowExternalRepo && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`code-proposal repoPath resolved outside the current RunForge workspace: ${target}. Set input.allowExternalRepo=true only when you intentionally want a read-only external local repo trial.`);
  }
}

function noDocsPatch(
  spec: RunSpec,
  reason: string,
  overrides: Partial<Pick<DeterministicCodeProposal, "outcome" | "evidenceFiles" | "diagnostics">> = {}
): DeterministicCodeProposal {
  return {
    taskSummary: spec.goal ?? "Prepare a docs proposal.",
    filesChanged: [],
    rationale: `No patch generated: ${reason}`,
    patch: "",
    outcome: overrides.outcome ?? "proposal_not_generated",
    evidenceFiles: overrides.evidenceFiles ?? [],
    diagnostics: overrides.diagnostics ?? [reason]
  };
}

async function validateDocsProposalEvidence(spec: RunSpec, scopedFiles?: string[]): Promise<{
  included: string[];
  errors: string[];
}> {
  if (!spec.docsProposal) return { included: [], errors: [] };
  const required = [...new Set([spec.docsProposal.targetFile, ...spec.docsProposal.evidenceFiles])];
  const scoped = scopedFiles ? new Set(scopedFiles) : new Set(required);
  const included: string[] = [];
  const errors: string[] = [];

  for (const file of required) {
    if (!scoped.has(file)) {
      errors.push(`${file} is not included in scoped context.`);
      continue;
    }
    const content = await readOptionalRepoFile(spec.repoPath, file);
    if (content === null) {
      errors.push(`${file} does not exist or is not readable under the repository root.`);
      continue;
    }
    included.push(file);
  }

  return { included, errors };
}

async function readOptionalRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    const root = resolve(repoPath);
    const path = resolve(root, relativePath);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return await readText(path);
  } catch {
    return null;
  }
}

function renderCalculatorAssertionPatch(): string {
  return [
    "diff --git a/tests/calculator.test.ts b/tests/calculator.test.ts",
    "--- a/tests/calculator.test.ts",
    "+++ b/tests/calculator.test.ts",
    '@@ -3,6 +3,6 @@ import { add } from "../src/calculator";',
    " ",
    ' describe("add", () => {',
    '   it("adds two numbers", () => {',
    "-    expect(add(1, 1)).toBe(3);",
    "+    expect(add(1, 1)).toBe(2);",
    "   });",
    " });"
  ].join("\n") + "\n";
}

function normalizeInsertedText(text: string): string {
  return text.startsWith("\n") ? text : `\n${text}`;
}

function renderUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const firstChanged = firstChangedLine(beforeLines, afterLines);
  const lastBeforeChanged = lastChangedLine(beforeLines, afterLines);
  const lastAfterChanged = lastChangedLine(afterLines, beforeLines);
  const context = 3;
  const beforeStart = Math.max(0, firstChanged - context);
  const afterStart = Math.max(0, firstChanged - context);
  const beforeEnd = Math.min(beforeLines.length, lastBeforeChanged + context + 1);
  const afterEnd = Math.min(afterLines.length, lastAfterChanged + context + 1);
  const hunk = renderDiffHunk(beforeLines.slice(beforeStart, beforeEnd), afterLines.slice(afterStart, afterEnd));

  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${afterStart + 1},${afterEnd - afterStart} @@`,
    ...hunk
  ].join("\n") + "\n";
}

interface DiffLine {
  text: string;
  hasNewline: boolean;
}

function splitLines(text: string): DiffLine[] {
  if (text.length === 0) return [];
  return text.split(/(?<=\n)/).map((line) => ({
    text: line.endsWith("\n") ? line.slice(0, -1) : line,
    hasNewline: line.endsWith("\n")
  }));
}

function pushDiffLine(hunk: string[], prefix: " " | "-" | "+", line: DiffLine): void {
  hunk.push(`${prefix}${line.text}`);
  if (!line.hasNewline) hunk.push("\\ No newline at end of file");
}

function firstChangedLine(left: DiffLine[], right: DiffLine[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameDiffLine(left[index], right[index])) return index;
  }
  return length;
}

function lastChangedLine(left: DiffLine[], right: DiffLine[]): number {
  let leftIndex = left.length - 1;
  let rightIndex = right.length - 1;
  while (leftIndex >= 0 && rightIndex >= 0 && sameDiffLine(left[leftIndex], right[rightIndex])) {
    leftIndex -= 1;
    rightIndex -= 1;
  }
  return Math.max(leftIndex, 0);
}

function sameDiffLine(left: DiffLine, right: DiffLine): boolean {
  return left.text === right.text && left.hasNewline === right.hasNewline;
}

function renderDiffHunk(beforeLines: DiffLine[], afterLines: DiffLine[]): string[] {
  const hunk: string[] = [];
  const lcs = buildLcsTable(beforeLines, afterLines);
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      sameDiffLine(beforeLines[beforeIndex], afterLines[afterIndex])
    ) {
      pushDiffLine(hunk, " ", beforeLines[beforeIndex]);
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex >= beforeLines.length || lcs[beforeIndex][afterIndex + 1] >= lcs[beforeIndex + 1][afterIndex])
    ) {
      pushDiffLine(hunk, "+", afterLines[afterIndex]);
      afterIndex += 1;
    } else if (beforeIndex < beforeLines.length) {
      pushDiffLine(hunk, "-", beforeLines[beforeIndex]);
      beforeIndex += 1;
    }
  }

  return hunk;
}

function buildLcsTable(beforeLines: DiffLine[], afterLines: DiffLine[]): number[][] {
  const table = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = sameDiffLine(beforeLines[beforeIndex], afterLines[afterIndex])
        ? table[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }
  return table;
}
