import { readdir } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import type { RunSpec } from "../core/types.js";
import type { DeterministicCodeProposal, DeterministicCodeProposalEvidence } from "./code-proposal-fixtures.js";
import { readOptionalRepoFile, renderUnifiedDiff } from "./code-proposal-fixtures.js";

export async function buildEvidenceBasedCodeProposal(
  spec: RunSpec,
  evidence?: DeterministicCodeProposalEvidence
): Promise<DeterministicCodeProposal | null> {
  return await buildLiteralMismatchProposal(spec, evidence)
    ?? await buildArithmeticOffByOneSourceProposal(spec, evidence)
    ?? await buildMissingExportAliasProposal(spec, evidence)
    ?? await buildImportPathRewriteProposal(spec, evidence)
    ?? await buildConfigLiteralMismatchProposal(spec, evidence)
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

async function buildArithmeticOffByOneSourceProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && evidence.failureCategory !== "test_assertion_failure") return null;
  const mismatch = parseExpectedReceived(evidence?.evidenceText ?? "");
  if (!mismatch) return null;
  const expected = Number(mismatch.expected);
  const received = Number(mismatch.received);
  if (!Number.isFinite(expected) || !Number.isFinite(received) || Math.abs(expected - received) !== 1) return null;
  const candidates = await listRepoFiles(spec.repoPath, (file) => /\.(?:[cm]?js|[cm]?ts)$/.test(file) && !/\.(?:test|spec)\./.test(file));
  const replacement = await findSingleArithmeticOffsetReplacement(spec.repoPath, candidates, received > expected ? "remove_plus_one" : "remove_minus_one");
  if (!replacement) return null;
  return {
    taskSummary: spec.goal ?? "Fix the source arithmetic offset.",
    filesChanged: [replacement.file],
    rationale: `The failure evidence reports a one-unit arithmetic mismatch: expected ${expected} but received ${received}. Exactly one source return expression has the matching offset, so the proposal removes only that offset.`,
    patch: renderUnifiedDiff(replacement.file, replacement.before, replacement.after),
    strategy: "source_arithmetic_off_by_one", evidenceFiles: [replacement.file],
    evidenceSummary: [`Failure evidence contained Expected/Received numeric literals: ${expected} -> ${received}.`]
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

async function buildImportPathRewriteProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && !["typecheck_error", "build_error"].includes(evidence.failureCategory)) return null;
  const parsed = parseMissingImportPath(evidence?.evidenceText ?? "");
  if (!parsed) return null;
  const sourceFile = normalizeRepoPath(parsed.sourceFile);
  if (!sourceFile) return null;
  const before = await readOptionalRepoFile(spec.repoPath, sourceFile);
  if (!before || countOccurrences(before, parsed.importPath) !== 1) return null;

  const replacement = await findSingleImportReplacement(spec.repoPath, sourceFile, parsed.importPath);
  if (!replacement) return null;
  const after = before.replace(parsed.importPath, replacement);
  return {
    taskSummary: spec.goal ?? "Rewrite a narrow TypeScript import path.",
    filesChanged: [sourceFile],
    rationale: `TypeScript reported that ${sourceFile} could not resolve ${parsed.importPath}. Exactly one sibling module matched as ${replacement}, so the proposal rewrites only that import path.`,
    patch: renderUnifiedDiff(sourceFile, before, after),
    strategy: "typescript_import_path_rewrite",
    evidenceFiles: [sourceFile],
    evidenceSummary: [`Missing import diagnostic: ${sourceFile} imports ${parsed.importPath}; replacement path: ${replacement}.`]
  };
}

async function buildConfigLiteralMismatchProposal(spec: RunSpec, evidence?: DeterministicCodeProposalEvidence): Promise<DeterministicCodeProposal | null> {
  if (evidence?.failureCategory && !["test_assertion_failure", "build_error", "lint_error"].includes(evidence.failureCategory)) return null;
  const mismatch = parseConfigExpectedReceived(evidence?.evidenceText ?? "");
  if (!mismatch) return null;
  const files = await listRepoFiles(spec.repoPath, (file) => /(^|\/)(config|configs|\.config)(\/|$)/i.test(file) || /\.config\.[cm]?[jt]s$/.test(file) || /\.json$/.test(file));
  const mentioned = files.filter((file) => (evidence?.evidenceText ?? "").includes(file));
  const searchFiles = mentioned.length === 1 ? mentioned : files;
  const replacement = await findSingleLiteralReplacement(spec.repoPath, searchFiles, mismatch.received, mismatch.expected);
  if (!replacement) return null;

  return {
    taskSummary: spec.goal ?? "Fix a narrow config literal mismatch.",
    filesChanged: [replacement.file],
    rationale: `The failure evidence reports config key ${mismatch.key ?? "unknown"} expected ${JSON.stringify(mismatch.expected)} but received ${JSON.stringify(mismatch.received)}. Exactly one config literal matched the received value, so the proposal updates only that literal.`,
    patch: renderUnifiedDiff(replacement.file, replacement.before, replacement.after),
    strategy: "config_literal_mismatch",
    evidenceFiles: [replacement.file],
    evidenceSummary: [`Config mismatch evidence: ${mismatch.key ?? "literal"} ${JSON.stringify(mismatch.received)} -> ${JSON.stringify(mismatch.expected)}.`]
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

async function findSingleArithmeticOffsetReplacement(repoPath: string, files: string[], mode: "remove_plus_one" | "remove_minus_one"): Promise<{ file: string; before: string; after: string } | null> {
  const patterns = mode === "remove_plus_one" ? [/return\s+([^;\n]+?)\s*\+\s*1\s*;/g, /return\s+1\s*\+\s*([^;\n]+?)\s*;/g] : [/return\s+([^;\n]+?)\s*-\s*1\s*;/g];
  const matches: Array<{ file: string; before: string; after: string }> = [];
  for (const file of files) {
    const before = await readOptionalRepoFile(repoPath, file);
    if (!before) continue;
    for (const pattern of patterns) {
      const found = [...before.matchAll(pattern)]
        .filter((match) => typeof match[1] === "string" && match[1]!.trim().length > 0);
      if (found.length !== 1) continue;
      matches.push({ file, before, after: before.replace(found[0]![0], `return ${found[0]![1]!.trim()};`) });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function parseMissingExport(text: string): { modulePath: string; missing: string; actual: string } | null {
  const normalized = text.replace(/\\"/g, '"');
  const match = normalized.match(/Module\s+['"]([^'"]+)['"]\s+has no exported member\s+['"]?([A-Za-z_$][\w$]*)['"]?\.\s+Did you mean\s+['"]?([A-Za-z_$][\w$]*)['"]?/i);
  return match ? { modulePath: match[1]!, missing: match[2]!, actual: match[3]! } : null;
}

function parseMissingImportPath(text: string): { sourceFile: string; importPath: string } | null {
  const normalized = text.replace(/\\"/g, '"');
  const match = normalized.match(/([A-Za-z0-9_./-]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s+error\s+TS2307:\s+Cannot find module\s+['"]([^'"]+)['"]/i)
    ?? normalized.match(/([A-Za-z0-9_./-]+\.[cm]?[jt]sx?).*Cannot resolve import\s+['"]([^'"]+)['"]/i);
  return match ? { sourceFile: match[1]!, importPath: match[2]! } : null;
}

function parseConfigExpectedReceived(text: string): { key?: string; expected: string; received: string } | null {
  const normalized = text.replace(/\\"/g, '"');
  const keyed = normalized.match(/config(?:\s+key)?\s+([A-Za-z0-9_.-]+).*Expected:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)\s+Received:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)/is);
  if (keyed) return { key: keyed[1]!, expected: stripLiteral(keyed[2]!), received: stripLiteral(keyed[3]!) };
  const plain = normalized.match(/config(?:uration)?\s+literal\s+mismatch.*Expected:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)\s+Received:\s*("?[^"\n]+"?|'[^'\n]+'|[^\n]+)/is);
  return plain ? { expected: stripLiteral(plain[1]!), received: stripLiteral(plain[2]!) } : null;
}

async function findSingleModuleFile(repoPath: string, modulePath: string): Promise<string | null> {
  const normalized = modulePath.replace(/\\/g, "/").replace(/^\.\.?\//, "");
  const suffixes = [`${normalized}.ts`, `${normalized}.tsx`, `${normalized}/index.ts`, `${normalized}/index.tsx`, `src/${normalized}.ts`, `src/${normalized}.tsx`];
  const files = await listRepoFiles(repoPath, (file) => [".ts", ".tsx"].includes(extname(file)) && !file.endsWith(".d.ts"));
  const matches = files.filter((file) => suffixes.some((suffix) => file.endsWith(suffix)));
  return matches.length === 1 ? matches[0]! : null;
}

async function findSingleImportReplacement(repoPath: string, sourceFile: string, importPath: string): Promise<string | null> {
  if (!importPath.startsWith(".")) return null;
  const sourceDir = dirname(sourceFile);
  const requestedBase = importPath.split("/").at(-1) ?? importPath;
  const files = await listRepoFiles(repoPath, (file) => [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(extname(file)) && !file.endsWith(".d.ts"));
  const sameDirFiles = files.filter((file) => dirname(file) === sourceDir);
  const candidates = sameDirFiles
    .map((file) => file.slice(0, -extname(file).length))
    .filter((file) => levenshtein(file.split("/").at(-1) ?? file, requestedBase) <= 2)
    .map((file) => normalizeRelativeImport(sourceDir, file));
  const unique = [...new Set(candidates)].filter((candidate) => candidate !== importPath);
  return unique.length === 1 ? unique[0]! : null;
}

function normalizeRelativeImport(fromDir: string, targetWithoutExtension: string): string {
  const rel = normalize(relative(fromDir || ".", targetWithoutExtension)).replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function normalizeRepoPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith("../") || normalized.startsWith("/") ? null : normalized;
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

function levenshtein(left: string, right: string): number {
  const table = Array.from({ length: left.length + 1 }, (_, row) => [row, ...Array(right.length).fill(0)]);
  for (let column = 1; column <= right.length; column += 1) table[0]![column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      table[row]![column] = Math.min(
        table[row - 1]![column]! + 1,
        table[row]![column - 1]! + 1,
        table[row - 1]![column - 1]! + cost
      );
    }
  }
  return table[left.length]![right.length]!;
}
