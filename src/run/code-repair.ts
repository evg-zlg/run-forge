import { execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodeReplacement = { find: string; replace: string; expected_count?: number };
export type CodeRepairChange = { file: string; replacements: CodeReplacement[] };
export type CodeRepairPlan = {
  schema_version: "runforge.code-repair.v1";
  candidate_id: string;
  task: string;
  allowed_files: string[];
  max_changed_files: number;
  validation_commands: string[];
  changes: CodeRepairChange[];
};

export function scopeCodeRepairPlan(plan: CodeRepairPlan, workingDirectory: string): CodeRepairPlan {
  if (workingDirectory === ".") return plan;
  const prefix = workingDirectory.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return { ...plan, allowed_files: plan.allowed_files.map((file) => `${prefix}/${file}`), changes: plan.changes.map((change) => ({ ...change, file: `${prefix}/${change.file}` })) };
}

const absoluteForbidden = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /(^|\/)(?:deploy|deployment|migrations?|prisma)(\/|$)/i,
  /(^|\/)(?:secrets?|credentials?)(\/|\.|$)/i
];

export async function loadCodeRepairPlan(path: string): Promise<CodeRepairPlan> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!isCodeRepairPlan(parsed)) throw new Error("Code repair plan is malformed or incomplete.");
  validateCodeRepairPlan(parsed);
  return parsed;
}

export function validateCodeRepairPlan(plan: CodeRepairPlan): void {
  if (plan.max_changed_files < 1 || plan.max_changed_files > 8) throw new Error("Code repair max_changed_files must be between 1 and 8.");
  const files = [...new Set(plan.changes.map((item) => item.file))];
  if (!files.length || files.length > plan.max_changed_files) throw new Error("Code repair exceeds the bounded changed-file count.");
  if (plan.allowed_files.length > plan.max_changed_files) throw new Error("Code repair allowed_files exceeds max_changed_files.");
  for (const file of files) {
    assertSafeRelativeFile(file);
    if (!plan.allowed_files.includes(file)) throw new Error(`Code repair file is outside allowed_files: ${file}`);
    if (absoluteForbidden.some((pattern) => pattern.test(file))) throw new Error(`Code repair file is forbidden by hard policy: ${file}`);
  }
  if (!plan.validation_commands.length || plan.validation_commands.some((command) => !isSafeValidationCommand(command))) {
    throw new Error("Code repair requires safe deterministic validation commands.");
  }
  for (const change of plan.changes) {
    if (!change.replacements.length) throw new Error(`Code repair change has no replacements: ${change.file}`);
    for (const replacement of change.replacements) {
      if (!replacement.find || replacement.find === replacement.replace) throw new Error(`Code repair replacement is empty or ineffective: ${change.file}`);
      const count = replacement.expected_count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(`Code repair expected_count is unsafe: ${change.file}`);
    }
  }
}

export async function applyCodeRepairPlan(workspace: string, plan: CodeRepairPlan): Promise<{ files: string[]; summary: string }> {
  const canonicalWorkspace = await realpath(workspace);
  for (const change of plan.changes) {
    const target = resolve(canonicalWorkspace, change.file);
    const canonicalTarget = await realpath(target);
    const inside = relative(canonicalWorkspace, canonicalTarget);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Code repair target escapes workspace: ${change.file}`);
    let text = await readFile(canonicalTarget, "utf8");
    for (const replacement of change.replacements) {
      const expected = replacement.expected_count ?? 1;
      const actual = text.split(replacement.find).length - 1;
      if (actual !== expected) throw new Error(`Code repair anchor count mismatch for ${change.file}: expected ${expected}, found ${actual}.`);
      text = text.split(replacement.find).join(replacement.replace);
    }
    await writeFile(canonicalTarget, text, "utf8");
  }
  return { files: [...new Set(plan.changes.map((item) => item.file))], summary: plan.task };
}

export function renderCodeRepairReport(plan: CodeRepairPlan, files: string[]): string {
  return `# Code Repair Report\n\n- Candidate: \`${plan.candidate_id}\`\n- Task: ${plan.task}\n- Files: ${files.map((file) => `\`${file}\``).join(", ")}\n- Maximum changed files: ${plan.max_changed_files}\n- Repair mechanism: exact bounded replacements\n- Provider calls: none\n`;
}

export async function createBoundedPatch(repo: string, workspace: string, files: string[], output: string, comparison: string): Promise<void> {
  await mkdir(join(comparison, "a"), { recursive: true }); await mkdir(join(comparison, "b"), { recursive: true });
  let combined = "";
  for (const file of files) {
    await mkdir(dirname(join(comparison, "a", file)), { recursive: true }); await mkdir(dirname(join(comparison, "b", file)), { recursive: true });
    await cp(join(repo, file), join(comparison, "a", file)); await cp(join(workspace, file), join(comparison, "b", file));
    let diff = ""; let exitCode = 0;
    try { diff = (await execFileAsync("git", ["diff", "--no-index", "--", `a/${file}`, `b/${file}`], { cwd: comparison })).stdout; }
    catch (value) { const error = value as { stdout?: string; code?: number }; diff = error.stdout ?? ""; exitCode = error.code ?? 2; }
    if (exitCode !== 1 || !diff) throw new Error(`Could not generate a non-empty repair patch for ${file}.`);
    combined += diff.replaceAll("a/a/", "a/").replaceAll("b/b/", "b/");
  }
  if (!reviewBoundedPatch(combined, files)) throw new Error("Generated patch failed the providerless path/scope review.");
  await writeFile(output, combined, "utf8");
}

export function reviewBoundedPatch(patch: string, allowedFiles: string[]): boolean {
  const files = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  return files.length === allowedFiles.length && files.every((match) => match[1] === match[2] && allowedFiles.includes(match[1]!))
    && allowedFiles.every((file) => patch.includes(`\n--- a/${file}\n+++ b/${file}\n`)) && !patch.includes("GIT binary patch");
}

function assertSafeRelativeFile(file: string): void {
  if (!file || isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Code repair file path is unsafe: ${file}`);
  }
}

function isSafeValidationCommand(command: string): boolean {
  if (/[;&|`$<>\n\r]/.test(command)) return false;
  return /^(?:npm (?:test|run [a-zA-Z0-9:_-]+)|corepack pnpm [a-zA-Z0-9:_-]+|pnpm [a-zA-Z0-9:_-]+|yarn [a-zA-Z0-9:_-]+)$/.test(command.trim());
}

function isCodeRepairPlan(value: unknown): value is CodeRepairPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<CodeRepairPlan>;
  return plan.schema_version === "runforge.code-repair.v1"
    && typeof plan.candidate_id === "string" && !!plan.candidate_id.trim()
    && typeof plan.task === "string" && !!plan.task.trim()
    && Array.isArray(plan.allowed_files) && plan.allowed_files.every((item) => typeof item === "string")
    && typeof plan.max_changed_files === "number"
    && Array.isArray(plan.validation_commands) && plan.validation_commands.every((item) => typeof item === "string")
    && Array.isArray(plan.changes) && plan.changes.every((change) => !!change && typeof change.file === "string" && Array.isArray(change.replacements) && change.replacements.every((item) => !!item && typeof item.find === "string" && typeof item.replace === "string"));
}
