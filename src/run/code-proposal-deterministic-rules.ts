import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { RunSpec } from "../core/types.js";
import type { DeterministicCodeProposal, DeterministicCodeProposalEvidence } from "./code-proposal-fixtures.js";
import { readOptionalRepoFile, renderUnifiedDiff } from "./code-proposal-fixtures.js";

export async function buildEvidenceBasedCodeProposal(
  spec: RunSpec,
  evidence?: DeterministicCodeProposalEvidence
): Promise<DeterministicCodeProposal | null> {
  return await buildLiteralMismatchProposal(spec, evidence)
    ?? await buildMissingExportAliasProposal(spec, evidence)
    ?? await buildPackageScriptAliasProposal(spec, evidence);
}

async function buildLiteralMismatchProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && evidence.failureCategory !== "test_assertion_failure") return null;
  const mismatch = parseExpectedReceived(evidence?.evidenceText ?? "");
  if (!mismatch) return null;

  const candidates = await listRepoFiles(spec.repoPath, (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  const mentioned = candidates.filter((file) => (evidence?.evidenceText ?? "").includes(file));
  const replacement = await findSingleLiteralReplacement(spec.repoPath, mentioned.length === 1 ? mentioned : candidates, mismatch.expected, mismatch.received);
  if (!replacement) return null;

  return {
    taskSummary: spec.goal ?? "Fix the assertion literal mismatch.",
    filesChanged: [replacement.file],
    rationale: `The failure evidence reports expected ${JSON.stringify(mismatch.expected)} but received ${JSON.stringify(mismatch.received)}. Exactly one test literal matched the expected value, so the proposal updates only that literal.`,
    patch: renderUnifiedDiff(replacement.file, replacement.before, replacement.after),
    strategy: "test_assertion_literal_mismatch",
    evidenceFiles: [replacement.file],
    evidenceSummary: [`Failure evidence contained Expected/Received literals: ${JSON.stringify(mismatch.expected)} -> ${JSON.stringify(mismatch.received)}.`]
  };
}

async function buildMissingExportAliasProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && evidence.failureCategory !== "typecheck_error") return null;
  const parsed = parseMissingExport(evidence?.evidenceText ?? "");
  if (!parsed) return null;
  const sourceFile = await findSingleModuleFile(spec.repoPath, parsed.modulePath);
  if (!sourceFile) return null;
  const before = await readOptionalRepoFile(spec.repoPath, sourceFile);
  if (!before || !hasNamedExport(before, parsed.actual) || hasNamedExport(before, parsed.missing)) return null;

  const after = `${before}${before.endsWith("\n") ? "" : "\n"}export { ${parsed.actual} as ${parsed.missing} };\n`;
  return {
    taskSummary: spec.goal ?? "Add a narrow TypeScript export alias.",
    filesChanged: [sourceFile],
    rationale: `TypeScript reported that ${parsed.modulePath} does not export ${parsed.missing} and suggested ${parsed.actual}. The source module exports ${parsed.actual}, so the proposal adds a single explicit alias export.`,
    patch: renderUnifiedDiff(sourceFile, before, after),
    strategy: "typescript_missing_export_alias",
    evidenceFiles: [sourceFile],
    evidenceSummary: [`Missing export diagnostic: ${parsed.missing}; suggested export: ${parsed.actual}; module: ${parsed.modulePath}.`]
  };
}

async function buildPackageScriptAliasProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && !["configuration_error", "unknown_failure"].includes(evidence.failureCategory)) return null;
  const missingScript = evidence?.evidenceText?.match(/Missing (?:npm )?script:?\s+["']([^"']+)["']/i)?.[1];
  if (!missingScript) return null;
  const before = await readOptionalRepoFile(spec.repoPath, "package.json");
  if (!before) return null;

  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(before) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
  const scripts = packageJson.scripts ?? {};
  if (scripts[missingScript]) return null;
  const aliasTarget = findScriptAliasTarget(missingScript, scripts);
  if (!aliasTarget) return null;
  const after = `${JSON.stringify({ ...packageJson, scripts: { ...scripts, [missingScript]: scripts[aliasTarget] } }, null, 2)}\n`;
  return {
    taskSummary: spec.goal ?? "Add a narrow package script alias.",
    filesChanged: ["package.json"],
    rationale: `The command requested missing package script ${missingScript}. package.json has one unambiguous sibling script, ${aliasTarget}, so the proposal adds ${missingScript} as an alias with the same command.`,
    patch: renderUnifiedDiff("package.json", before, after),
    strategy: "package_script_alias",
    evidenceFiles: ["package.json"],
    evidenceSummary: [`Missing package script: ${missingScript}; alias target: ${aliasTarget}.`]
  };
}

function parseExpectedReceived(text: string): { expected: string; received: string } | null {
  const jest = text.match(/Expected:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)\s+Received:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)/i);
  if (jest) return { expected: stripLiteral(jest[1]!), received: stripLiteral(jest[2]!) };
  const chai = text.match(/expected\s+(.+?)\s+to\s+(?:equal|be)\s+(.+?)(?:\n|$)/i);
  return chai ? { expected: stripLiteral(chai[2]!), received: stripLiteral(chai[1]!) } : null;
}

function stripLiteral(value: string): string {
  const trimmed = value.trim().replace(/[.,;]$/, "");
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed;
}

async function findSingleLiteralReplacement(repoPath: string, files: string[], expected: string, received: string): Promise<{ file: string; before: string; after: string } | null> {
  const matches: Array<{ file: string; before: string; after: string }> = [];
  for (const file of files) {
    const before = await readOptionalRepoFile(repoPath, file);
    if (!before) continue;
    const replacement = [{ from: JSON.stringify(expected), to: JSON.stringify(received) }, { from: `'${expected}'`, to: `'${received}'` }, { from: expected, to: received }]
      .find((candidate) => countOccurrences(before, candidate.from) === 1);
    if (replacement) matches.push({ file, before, after: before.replace(replacement.from, replacement.to) });
  }
  return matches.length === 1 ? matches[0]! : null;
}

function parseMissingExport(text: string): { modulePath: string; missing: string; actual: string } | null {
  const normalized = text.replace(/\\"/g, '"');
  const match = normalized.match(/Module\s+['"]([^'"]+)['"]\s+has no exported member\s+['"]?([A-Za-z_$][\w$]*)['"]?\.\s+Did you mean\s+['"]?([A-Za-z_$][\w$]*)['"]?/i);
  return match ? { modulePath: match[1]!, missing: match[2]!, actual: match[3]! } : null;
}

async function findSingleModuleFile(repoPath: string, modulePath: string): Promise<string | null> {
  const normalized = modulePath.replace(/\\/g, "/").replace(/^\.\.?\//, "");
  const suffixes = [`${normalized}.ts`, `${normalized}.tsx`, `${normalized}/index.ts`, `${normalized}/index.tsx`, `src/${normalized}.ts`, `src/${normalized}.tsx`];
  const files = await listRepoFiles(repoPath, (file) => [".ts", ".tsx"].includes(extname(file)) && !file.endsWith(".d.ts"));
  const matches = files.filter((file) => suffixes.some((suffix) => file.endsWith(suffix)));
  return matches.length === 1 ? matches[0]! : null;
}

function hasNamedExport(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`export\\s+(?:function|const|let|var|class|interface|type)\\s+${escaped}\\b`).test(source) ||
    new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source);
}

function findScriptAliasTarget(missingScript: string, scripts: Record<string, string>): string | null {
  const names = Object.keys(scripts);
  const exactSuffix = names.filter((name) => name.endsWith(`:${missingScript}`) || missingScript.endsWith(`:${name}`));
  if (exactSuffix.length === 1) return exactSuffix[0]!;
  const samePrefix = missingScript.includes(":") ? names.filter((name) => name.split(":")[0] === missingScript.split(":")[0]) : [];
  return samePrefix.length === 1 ? samePrefix[0]! : null;
}

async function listRepoFiles(repoPath: string, predicate: (file: string) => boolean): Promise<string[]> {
  const root = resolve(repoPath);
  const results: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    for (const entry of await readdir(join(root, relativeDir), { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && predicate(relativePath)) results.push(relativePath);
    }
  }
  await visit("");
  return results;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (needle && (index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}
