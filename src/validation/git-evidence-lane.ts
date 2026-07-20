import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const forbiddenSyntax = /[;&|`$<>\\\n\r'"(){}\[\]*?!]/;

export const GIT_EVIDENCE_SAFETY_ASSERTIONS = [
  "argv_only_no_shell", "read_only_allowlist", "expected_sha_verified_before_and_after",
  "canonical_repository_identity_verified", "hooks_disabled", "credentials_disabled", "prompts_disabled",
  "remote_helpers_disabled", "external_network_disabled", "optional_locks_disabled", "source_state_immutable",
  "external_diff_disabled", "textconv_disabled", "mutable_refs_rejected",
] as const;

export class GitEvidenceCapabilityUnsupportedError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`capability_unsupported: ${reason}`, options);
    this.name = "GitEvidenceCapabilityUnsupportedError";
  }
}

export type GitEvidenceBinding = {
  lane: "git-evidence";
  cwd: string;
  evidenceWorkspace: string;
  repositoryIdentity: string;
  gitCommonDirectory: string;
  boundSha: string;
  safetyAssertions: string[];
};

export type ParsedGitEvidence = { supported: true; argv: string[]; kind: "status" | "diff-check" | "rev-parse" | "merge-base" | "changed-paths" }
  | { supported: false; reason: string };

export function parseGitEvidenceCommand(command: string, expectedSha?: string): ParsedGitEvidence {
  const trimmed = command.trim();
  if (!trimmed.startsWith("git ") || forbiddenSyntax.test(trimmed) || /\s{2,}|\t/.test(trimmed)) return unsupported("Shell syntax, quoting, globbing, substitutions, redirects, or malformed spacing are unsupported.");
  const argv = trimmed.split(" ");
  if (argv[0] !== "git" || argv.some((item) => !item)) return unsupported("The command must be a structurally parseable Git argv form.");
  const args = argv.slice(1);
  if (args[0] === "status" && (equal(args, ["status", "--porcelain"]) || equal(args, ["status", "--porcelain=v1"]))) return ok(argv, "status");
  if (args[0] === "diff" && (args[1] === "--check" || args[1] === "--name-only") && args.length <= 3) {
    if (args[2] && !safeRange(args[2], expectedSha)) return unsupported("Git diff accepts only a bounded range of HEAD, the expected SHA, or full object IDs.");
    const range = args[2] ? canonicalRange(args[2], expectedSha) : [];
    return ok(["git", "diff", "--no-ext-diff", "--no-textconv", args[1], ...range], args[1] === "--check" ? "diff-check" : "changed-paths");
  }
  if (args[0] === "rev-parse" && args.length === 2 && safeRevision(args[1]!, expectedSha)) return ok(["git", "rev-parse", canonicalRevision(args[1]!, expectedSha)], "rev-parse");
  if (args[0] === "merge-base" && args.length === 3 && safeRevision(args[1]!, expectedSha) && safeRevision(args[2]!, expectedSha)) return ok(["git", "merge-base", canonicalRevision(args[1]!, expectedSha), canonicalRevision(args[2]!, expectedSha)], "merge-base");
  return unsupported("Only status porcelain, diff --check, diff --name-only, bounded rev-parse, and two-revision merge-base are supported.");
}

export async function createGitEvidenceBinding(input: { targetRepository: string; evidenceWorkspace: string; expectedSha: string }): Promise<GitEvidenceBinding> {
  try {
    if (!fullSha.test(input.expectedSha)) throw new Error("git_evidence_binding_invalid_sha: expected a full object ID");
    const repositoryIdentity = await realpath(input.targetRepository);
    const evidenceWorkspace = await realpath(input.evidenceWorkspace);
    const targetCommon = await gitText(repositoryIdentity, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evidenceCommon = await gitText(evidenceWorkspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const [canonicalTargetCommon, canonicalEvidenceCommon] = await Promise.all([realpath(resolve(repositoryIdentity, targetCommon)), realpath(resolve(evidenceWorkspace, evidenceCommon))]);
    if (canonicalTargetCommon !== canonicalEvidenceCommon) throw new Error("git_evidence_repository_identity_mismatch");
    const head = await gitText(evidenceWorkspace, ["rev-parse", "HEAD"]);
    if (head !== input.expectedSha) throw new Error(`git_evidence_sha_mismatch: expected ${input.expectedSha}, current ${head}`);
    return { lane: "git-evidence", cwd: evidenceWorkspace, evidenceWorkspace, repositoryIdentity, gitCommonDirectory: canonicalTargetCommon, boundSha: input.expectedSha, safetyAssertions: [...GIT_EVIDENCE_SAFETY_ASSERTIONS] };
  } catch (error) {
    if (error instanceof GitEvidenceCapabilityUnsupportedError) throw error;
    throw new GitEvidenceCapabilityUnsupportedError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export async function executeGitEvidence(input: { binding: GitEvidenceBinding; command: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ argv: string[]; stdout: string; stderr: string; exitCode: number; sourceUnchanged: boolean }> {
  const parsed = parseGitEvidenceCommand(input.command, input.binding.boundSha);
  if (!parsed.supported) throw new GitEvidenceCapabilityUnsupportedError(parsed.reason);
  let sourceBefore: string, evidenceBefore: string;
  try {
    await assertBinding(input.binding);
    [sourceBefore, evidenceBefore] = await Promise.all([sourceFingerprint(input.binding.repositoryIdentity), sourceFingerprint(input.binding.evidenceWorkspace)]);
  } catch (error) {
    throw asCapabilityUnsupported(error);
  }
  const argv = ["--no-pager", "-C", input.binding.evidenceWorkspace, ...parsed.argv.slice(1)];
  let stdout = "", stderr = "", exitCode = 0;
  try {
    const result = await execFileAsync("git", argv, { env: safeGitEnvironment(), timeout: input.timeoutMs, signal: input.signal, maxBuffer: 1_000_000 });
    stdout = result.stdout; stderr = result.stderr;
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    stdout = detail.stdout ?? ""; stderr = detail.stderr ?? detail.message; exitCode = typeof detail.code === "number" ? detail.code : 1;
  }
  let sourceAfter: string, evidenceAfter: string;
  try {
    await assertBinding(input.binding);
    [sourceAfter, evidenceAfter] = await Promise.all([sourceFingerprint(input.binding.repositoryIdentity), sourceFingerprint(input.binding.evidenceWorkspace)]);
  } catch (error) {
    throw asCapabilityUnsupported(error);
  }
  const sourceUnchanged = sourceBefore === sourceAfter && evidenceBefore === evidenceAfter;
  if (!sourceUnchanged) throw new GitEvidenceCapabilityUnsupportedError("git_evidence_source_mutation_detected");
  return { argv: parsed.argv, stdout, stderr, exitCode, sourceUnchanged };
}

export async function sourceFingerprint(repository: string): Promise<string> {
  const canonical = await realpath(repository);
  const commonText = await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = await realpath(resolve(canonical, commonText));
  const gitDirectoryText = await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const gitDirectory = await realpath(resolve(canonical, gitDirectoryText));
  const head = await gitText(canonical, ["rev-parse", "HEAD"]);
  const status = await gitText(canonical, ["status", "--porcelain=v1"]);
  const digest = createHash("sha256").update(`repo\0${canonical}\0head\0${head}\0status\0${status}\0`);
  for (const path of [join(gitDirectory, "HEAD"), join(gitDirectory, "index"), join(common, "packed-refs"), join(common, "refs")]) await hashPath(digest, path, common);
  const visiblePaths = (await gitRaw(canonical, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean).sort();
  for (const path of visiblePaths) await hashPath(digest, join(canonical, path), canonical);
  return digest.digest("hex");
}

async function assertBinding(binding: GitEvidenceBinding): Promise<void> {
  if (binding.cwd !== binding.evidenceWorkspace || GIT_EVIDENCE_SAFETY_ASSERTIONS.some((assertion) => !binding.safetyAssertions.includes(assertion))) {
    throw new GitEvidenceCapabilityUnsupportedError("git_evidence_safety_binding_incomplete");
  }
  const rebound = await createGitEvidenceBinding({ targetRepository: binding.repositoryIdentity, evidenceWorkspace: binding.evidenceWorkspace, expectedSha: binding.boundSha });
  if (rebound.repositoryIdentity !== binding.repositoryIdentity || rebound.evidenceWorkspace !== binding.evidenceWorkspace || rebound.gitCommonDirectory !== binding.gitCommonDirectory) throw new Error("git_evidence_repository_identity_mismatch");
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}
async function gitRaw(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", ["--no-pager", "-C", cwd, ...args], { env: safeGitEnvironment(), maxBuffer: 10_000_000 })).stdout; }

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, LANG: "C", LC_ALL: "C", HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_PROTOCOL_FROM_USER: "0", GIT_ALLOW_PROTOCOL: "file", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "", GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "diff.external", GIT_CONFIG_VALUE_3: "",
  };
}

async function hashPath(hash: ReturnType<typeof createHash>, path: string, base: string): Promise<void> {
  let stat; try { stat = await lstat(path); } catch { hash.update(`missing\0${path}\0`); return; }
  hash.update(`${path.slice(base.length)}\0${stat.mode}\0${stat.size}\0`);
  if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await hashPath(hash, join(path, name), base);
  else if (stat.isFile()) hash.update(await readFile(path));
}
function safeRevision(value: string, expectedSha?: string): boolean { return fullSha.test(value) || value === expectedSha || (value === "HEAD" && Boolean(expectedSha && fullSha.test(expectedSha))); }
function canonicalRevision(value: string, expectedSha?: string): string { return value === "HEAD" && expectedSha ? expectedSha : value; }
function safeRange(value: string, expectedSha?: string): boolean { const match = /^(.*?)(\.\.\.?)(.*?)$/.exec(value); return Boolean(match && safeRevision(match[1]!, expectedSha) && safeRevision(match[3]!, expectedSha)); }
function canonicalRange(value: string, expectedSha?: string): string[] { const match = /^(.*?)(\.\.\.?)(.*?)$/.exec(value); return match ? [`${canonicalRevision(match[1]!, expectedSha)}${match[2]}${canonicalRevision(match[3]!, expectedSha)}`] : []; }
function asCapabilityUnsupported(error: unknown): GitEvidenceCapabilityUnsupportedError { return error instanceof GitEvidenceCapabilityUnsupportedError ? error : new GitEvidenceCapabilityUnsupportedError(error instanceof Error ? error.message : String(error), { cause: error }); }
function equal(a: string[], b: string[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]); }
function ok(argv: string[], kind: Extract<ParsedGitEvidence, { supported: true }>["kind"]): ParsedGitEvidence { return { supported: true, argv, kind }; }
function unsupported(reason: string): ParsedGitEvidence { return { supported: false, reason }; }
