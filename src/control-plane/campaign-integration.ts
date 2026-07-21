import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type GitResult = { stdout: string; stderr: string };
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;
export type CampaignWorktree = { worktreeRoot: string; branch: string; baseSha: string; headSha: string };
export type PatchIntegration = { status: "integrated" | "no_changes"; headSha: string; commit: string | null; changedFiles: string[] };

export class CampaignIntegrationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CampaignIntegrationError"; }
}

export class CampaignIntegration {
  constructor(private readonly git: GitRunner = runGit) {}

  async ensureCampaignWorktree(input: { sourceRepository: string; stateRoot: string; campaignId: string; baseSha: string }): Promise<CampaignWorktree> {
    const sourceRepository = await realpath(input.sourceRepository).catch(() => { throw failure("SOURCE_REPOSITORY_MISSING"); });
    const stateRoot = await realpath(resolve(input.stateRoot)).catch(() => { throw failure("STATE_ROOT_MISSING"); });
    const worktreeRoot = resolve(stateRoot, "campaign-worktrees", input.campaignId);
    assertInside(stateRoot, worktreeRoot, "WORKTREE_PATH_ESCAPE");
    const branch = `runforge/campaign/${input.campaignId}`;
    const existing = await lstat(worktreeRoot).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure("WORKTREE_INVALID");
      const canonical = await realpath(worktreeRoot);
      assertInside(stateRoot, canonical, "WORKTREE_PATH_ESCAPE");
      const [head, root] = await Promise.all([this.git(canonical, ["rev-parse", "HEAD"]), this.git(canonical, ["rev-parse", "--show-toplevel"])]).catch(() => { throw failure("WORKTREE_REOPEN_FAILED"); });
      if (await realpath(root.stdout.trim()) !== canonical) throw failure("WORKTREE_IDENTITY_MISMATCH");
      return { worktreeRoot: canonical, branch, baseSha: input.baseSha, headSha: head.stdout.trim() };
    }
    await mkdir(dirname(worktreeRoot), { recursive: true });
    await this.git(sourceRepository, ["cat-file", "-e", `${input.baseSha}^{commit}`]).catch(() => { throw failure("BASE_SHA_MISSING"); });
    await this.git(sourceRepository, ["worktree", "add", "-b", branch, worktreeRoot, input.baseSha]).catch(() => { throw failure("WORKTREE_CREATE_FAILED"); });
    const canonical = await realpath(worktreeRoot);
    assertInside(stateRoot, canonical, "WORKTREE_PATH_ESCAPE");
    const headSha = (await this.git(canonical, ["rev-parse", "HEAD"])).stdout.trim();
    return { worktreeRoot: canonical, branch, baseSha: input.baseSha, headSha };
  }

  async currentCampaignHead(input: { stateRoot: string; worktreeRoot: string }): Promise<string> {
    const worktree = await this.validatedWorktree(input.stateRoot, input.worktreeRoot);
    return (await this.git(worktree, ["rev-parse", "HEAD"]).catch(() => { throw failure("WORKTREE_HEAD_FAILED"); })).stdout.trim();
  }

  async integrateChildPatch(input: { stateRoot: string; worktreeRoot: string; patchRoot: string; patchPath: string; allowedScopes: string[]; nodeId: string; maxPatchBytes?: number }): Promise<PatchIntegration> {
    const worktree = await this.validatedWorktree(input.stateRoot, input.worktreeRoot);
    const patchRoot = await realpath(input.patchRoot).catch(() => { throw failure("PATCH_ROOT_MISSING"); });
    const requestedPatch = resolve(input.patchPath);
    const metadata = await lstat(requestedPatch).catch(() => null);
    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) throw failure("PATCH_NOT_REGULAR");
    const patchPath = await realpath(requestedPatch);
    assertInside(patchRoot, patchPath, "PATCH_PATH_ESCAPE");
    if (metadata.size > (input.maxPatchBytes ?? 500_000)) throw failure("PATCH_OVERSIZE");
    const patch = await readFile(patchPath, "utf8");
    const changedFiles = parsePatchPaths(patch);
    if (!changedFiles.length) { if (patch.trim()) throw failure("PATCH_PATH_UNSUPPORTED"); return { status: "no_changes", headSha: await this.currentCampaignHead(input), commit: null, changedFiles: [] }; }
    const prior = await this.currentCampaignHead(input);
    const dirty = (await this.git(worktree, ["status", "--porcelain=v1"]).catch(() => { throw failure("WORKTREE_STATUS_FAILED"); })).stdout;
    if (dirty.trim()) throw failure("WORKTREE_NOT_CLEAN");
    try {
      // Scope rejection is inside the rollback boundary as defense in depth:
      // the dedicated campaign worktree is restored to the known head for any
      // rejected child artifact, even if future validation gains a mutating
      // preflight step.
      for (const path of changedFiles) if (!safeRelativePath(path) || !input.allowedScopes.some((scope) => scopeContains(scope, path))) throw failure("PATCH_SCOPE_VIOLATION");
      try { await this.git(worktree, ["apply", "--check", patchPath]); }
      catch {
        const alreadyApplied = await this.git(worktree, ["apply", "--reverse", "--check", patchPath]).then(() => true).catch(() => false);
        if (alreadyApplied) return { status: "no_changes", headSha: prior, commit: null, changedFiles };
        throw failure("PATCH_APPLY_FAILED");
      }
      await this.git(worktree, ["apply", "--index", patchPath]);
      const staged = splitNul((await this.git(worktree, ["diff", "--cached", "--name-only", "-z"])).stdout).sort();
      if (staged.join("\0") !== [...changedFiles].sort().join("\0")) throw failure("PATCH_STAGE_MISMATCH");
      await this.git(worktree, ["-c", "user.name=RunForge", "-c", "user.email=runforge@localhost", "commit", "--no-verify", "-m", `RunForge campaign node ${input.nodeId}`]);
      const commit = await this.currentCampaignHead(input);
      return { status: "integrated", headSha: commit, commit, changedFiles: staged };
    } catch (error) {
      await this.git(worktree, ["reset", "--hard", prior]).catch(() => undefined);
      await this.git(worktree, ["clean", "-fd"]).catch(() => undefined);
      if (error instanceof CampaignIntegrationError) throw error;
      throw failure("PATCH_APPLY_FAILED");
    }
  }

  private async validatedWorktree(stateRootInput: string, worktreeInput: string): Promise<string> {
    const stateRoot = await realpath(resolve(stateRootInput)).catch(() => { throw failure("STATE_ROOT_MISSING"); }), requested = resolve(worktreeInput);
    assertInside(stateRoot, requested, "WORKTREE_PATH_ESCAPE");
    const metadata = await lstat(requested).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw failure("WORKTREE_INVALID");
    const canonical = await realpath(requested);
    assertInside(stateRoot, canonical, "WORKTREE_PATH_ESCAPE");
    const root = await this.git(canonical, ["rev-parse", "--show-toplevel"]).catch(() => { throw failure("WORKTREE_IDENTITY_MISMATCH"); });
    if (await realpath(root.stdout.trim()) !== canonical) throw failure("WORKTREE_IDENTITY_MISMATCH");
    return canonical;
  }
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const safeArgs = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never", ...args];
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_OPTIONAL_LOCKS: "0" };
  return execFileAsync("git", safeArgs, { cwd, env, maxBuffer: 2_000_000 }) as Promise<GitResult>;
}
function parsePatchPaths(patch: string): string[] { const paths = new Set<string>(); for (const line of patch.split(/\r?\n/)) { if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue; const raw = line.slice(4).split("\t", 1)[0]!; if (raw === "/dev/null") continue; if (raw.startsWith('"')) throw failure("PATCH_PATH_UNSUPPORTED"); const path = raw.replace(/^[ab]\//, ""); paths.add(path); } return [...paths]; }
function safeRelativePath(path: string): boolean { return Boolean(path) && !path.startsWith("/") && !path.split("/").includes("..") && !/(^|\/)(?:\.git|\.env(?:\..*)?|node_modules|dist|coverage|generated|secrets?|credentials?)(\/|$)/i.test(path); }
function scopeContains(scope: string, path: string): boolean { if (!safeRelativePath(scope)) return false; const normalized = scope.replace(/\/$/, ""); return path === normalized || path.startsWith(`${normalized}/`); }
function assertInside(root: string, path: string, code: string): void { const rel = relative(root, path); if (rel.startsWith("..") || rel.startsWith("/")) throw failure(code); }
function splitNul(value: string): string[] { return value.split("\0").filter(Boolean); }
function failure(code: string): CampaignIntegrationError { return new CampaignIntegrationError(code); }
