import { readText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface DeterministicCodeProposal {
  taskSummary: string;
  filesChanged: string[];
  rationale: string;
  patch: string;
}

export async function buildFixtureCodeProposal(spec: RunSpec): Promise<DeterministicCodeProposal | null> {
  assertExternalCodeProposalAllowed(spec);
  const docsProposal = await buildDocsProposal(spec);
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

async function buildDocsProposal(spec: RunSpec): Promise<DeterministicCodeProposal | null> {
  if (!spec.docsProposal) return null;
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
    patch: renderUnifiedDiff(spec.docsProposal.targetFile, source, nextSource)
  };
}

function assertExternalCodeProposalAllowed(spec: RunSpec): void {
  const root = resolve(process.cwd());
  const target = resolve(spec.repoPath);
  const rel = relative(root, target);
  if (!spec.allowExternalRepo && !spec.docsProposal?.allowExternalRepo && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("code-proposal repoPath must resolve inside the current RunForge workspace unless input.allowExternalRepo=true.");
  }
}

function noDocsPatch(spec: RunSpec, reason: string): DeterministicCodeProposal {
  return {
    taskSummary: spec.goal ?? "Prepare a docs proposal.",
    filesChanged: [],
    rationale: `No patch generated: ${reason}`,
    patch: ""
  };
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
  const hunk: string[] = [];
  let beforeIndex = beforeStart;
  let afterIndex = afterStart;

  while (beforeIndex < beforeEnd || afterIndex < afterEnd) {
    if (beforeIndex < beforeEnd && afterIndex < afterEnd && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      hunk.push(` ${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    if (beforeIndex < beforeEnd && (afterIndex >= afterEnd || !afterLines.slice(afterIndex, afterEnd).includes(beforeLines[beforeIndex]))) {
      hunk.push(`-${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
    }
    if (afterIndex < afterEnd && (beforeIndex >= beforeEnd || !beforeLines.slice(beforeIndex, beforeEnd).includes(afterLines[afterIndex]))) {
      hunk.push(`+${afterLines[afterIndex]}`);
      afterIndex += 1;
    }
  }

  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${afterStart + 1},${afterEnd - afterStart} @@`,
    ...hunk
  ].join("\n") + "\n";
}

function splitLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

function firstChangedLine(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

function lastChangedLine(left: string[], right: string[]): number {
  let leftIndex = left.length - 1;
  let rightIndex = right.length - 1;
  while (leftIndex >= 0 && rightIndex >= 0 && left[leftIndex] === right[rightIndex]) {
    leftIndex -= 1;
    rightIndex -= 1;
  }
  return Math.max(leftIndex, 0);
}
