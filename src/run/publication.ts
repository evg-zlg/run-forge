import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuthorityClassification, AuthorityEnvelope } from "./delegated-authority.js";
import { recordAuthorityDecision, type AuthorityDecision } from "./delegated-authority.js";
import { inspectRepoState, type RepoState } from "./runtime-preparation.js";

const execFileAsync = promisify(execFile);
export type PublicationAction = "commit_to_non_main_branch" | "push_non_main_branch" | "create_draft_pr";

export function evaluatePublicationAction(envelope: AuthorityEnvelope, input: { action: PublicationAction; branch: string; sourceBranch: string; defaultBranch: string; sourceClean: boolean; expectedPatchHash: string; currentPatchHash: string; draft: boolean }): { classification: AuthorityClassification; reason: string } {
  if (envelope.allowed_actions[input.action] !== true) return { classification: "too_narrow", reason: `Authority does not allow ${input.action}.` };
  const publication = envelope.publication;
  if (!publication?.allowed || publication.branch_name !== input.branch) return { classification: "mismatched", reason: "Publication branch differs from the authority-bound branch." };
  if (!input.sourceClean) return { classification: "stale", reason: "Factory main is dirty or changed." };
  if (["main", "master", input.defaultBranch, input.sourceBranch].map((value) => value.toLowerCase()).includes(input.branch.toLowerCase())) return { classification: "mismatched", reason: "Publication target is main, master, default, or source branch." };
  if (input.expectedPatchHash !== input.currentPatchHash) return { classification: "stale", reason: "Patch hash changed after authority binding." };
  if (input.action === "create_draft_pr" && publication.draft_only && !input.draft) return { classification: "too_broad", reason: "Authority permits draft PR creation only." };
  if (envelope.expires_at !== null && Date.parse(envelope.expires_at) <= Date.now()) return { classification: "expired", reason: "Authority expired before publication action." };
  return { classification: "accepted", reason: `Authority independently covers ${input.action}.` };
}

export async function commitPublicationBranch(input: { worktree: string; message: string }): Promise<string> {
  await execFileAsync("git", ["add", "--", "README.md"], { cwd: input.worktree });
  await execFileAsync("git", ["-c", "user.name=RunForge", "-c", "user.email=runforge@example.invalid", "commit", "-m", input.message], { cwd: input.worktree });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.worktree })).stdout.trim();
}

export async function pushPublicationBranch(input: { repo: string; worktree: string; branch: string; expectedRemoteHead: string | null }): Promise<void> {
  const currentRemote = await remoteBranchHead(input.repo, input.branch);
  if (currentRemote !== input.expectedRemoteHead) throw new Error("Remote branch changed after publication preflight.");
  await execFileAsync("git", ["push", "origin", `refs/heads/${input.branch}:refs/heads/${input.branch}`], { cwd: input.worktree });
}

export async function createDraftPublicationPr(input: { repoFullName: string; branch: string; base: string; title: string; bodyFile: string }): Promise<string> {
  return (await execFileAsync("gh", ["pr", "create", "--repo", input.repoFullName, "--draft", "--base", input.base, "--head", input.branch, "--title", input.title, "--body-file", input.bodyFile])).stdout.trim();
}

export async function remoteBranchHead(repo: string, branch: string): Promise<string | null> {
  const output = (await execFileAsync("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repo })).stdout.trim();
  return output ? output.split(/\s+/)[0]! : null;
}

export function assertExpectedRemoteBranch(remoteHead: string | null, sourceHead: string): void { if (remoteHead !== null && remoteHead !== sourceHead) throw new Error("Existing remote publication branch does not match the recorded source HEAD."); }

export async function githubRepository(repo: string): Promise<{ nameWithOwner: string; defaultBranch: string }> {
  const remote = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repo })).stdout.trim();
  const match = remote.match(/(?:github\.com[/:]|git@[^:]+:)([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("Factory origin does not expose an unambiguous owner/repository path.");
  const nameWithOwner = `${match[1]}/${match[2]}`;
  const data = JSON.parse((await execFileAsync("gh", ["repo", "view", nameWithOwner, "--json", "defaultBranchRef"])).stdout) as { defaultBranchRef: { name: string } };
  return { nameWithOwner, defaultBranch: data.defaultBranchRef.name };
}

export async function currentPatchHash(path: string): Promise<string> {
  const { createHash } = await import("node:crypto"); return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function sourceMatchesBaseline(current: RepoState, baseline: RepoState): boolean {
  return current.status === "" && current.head === baseline.head;
}

export async function runPublication(input: { authority: AuthorityEnvelope; repo: string; sourceBefore: RepoState; worktree: string; branch: string; out: string; runId: string; patchPath: string; patchPackageHash: string; patchDiffHash: string; validate: (stage: "after-commit" | "after-push") => Promise<boolean> }): Promise<{ publication: "draft-pr-created" | "committed-not-pushed" | "pushed-no-pr" | "skipped-needs-owner-approval" | "failed"; prStatus: "draft-open" | "not-created" | "failed"; commitSha: string | null; prUrl: string | null }> {
  const repository = await githubRepository(input.repo); const remoteBefore = await remoteBranchHead(input.repo, input.branch); const patchHash = await currentPatchHash(input.patchPath); const sourceBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: input.repo })).stdout.trim();
  const sourceCurrent = await inspectRepoState(input.repo);
  const common = { branch: input.branch, sourceBranch, defaultBranch: repository.defaultBranch, sourceClean: sourceMatchesBaseline(sourceCurrent, input.sourceBefore), expectedPatchHash: input.patchDiffHash, currentPatchHash: patchHash, draft: true };
  const decide = async (action: PublicationAction) => { const check = evaluatePublicationAction(input.authority, { ...common, action }); const item: AuthorityDecision = { timestamp: new Date().toISOString(), authority_id: input.authority.authority_id, run_id: input.runId, action, decision: check.classification === "accepted" ? "continue" : "stop", classification: check.classification, reason: check.reason, repo: input.repo, target_mode: action === "create_draft_pr" ? "draft-pr" : "local-non-main-branch", risk: "low", patch_package_hash: input.patchPackageHash, patch_diff_hash: input.patchDiffHash }; await recordAuthorityDecision(join(input.out, "authority-decision-log.jsonl"), item); await appendFile(join(input.out, "authority-report.md"), `- ${item.timestamp} — \`${item.action}\`: **${item.decision}** (${item.classification}) — ${item.reason}\n`); return check.classification === "accepted"; };
  assertExpectedRemoteBranch(remoteBefore, input.sourceBefore.head);
  if (!await decide("commit_to_non_main_branch")) return { publication: "skipped-needs-owner-approval", prStatus: "not-created", commitSha: null, prUrl: null };
  const commitSha = await commitPublicationBranch({ worktree: input.worktree, message: input.authority.publication!.commit_message });
  if (!await input.validate("after-commit")) return { publication: "failed", prStatus: "not-created", commitSha, prUrl: null };
  if (!await decide("push_non_main_branch")) return { publication: "committed-not-pushed", prStatus: "not-created", commitSha, prUrl: null };
  await pushPublicationBranch({ repo: input.repo, worktree: input.worktree, branch: input.branch, expectedRemoteHead: remoteBefore });
  if (!await input.validate("after-push")) return { publication: "failed", prStatus: "not-created", commitSha, prUrl: null };
  if (!await decide("create_draft_pr")) return { publication: "pushed-no-pr", prStatus: "not-created", commitSha, prUrl: null };
  const prUrl = await createDraftPublicationPr({ repoFullName: repository.nameWithOwner, branch: input.branch, base: repository.defaultBranch, title: input.authority.publication!.pr_title, bodyFile: join(input.out, "pr-package", "pr-body.md") });
  await writeFile(join(input.out, "publication-report.md"), `# Publication Report\n\n- Branch: \`${input.branch}\`\n- Commit: \`${commitSha}\`\n- Push: completed without force\n- Draft PR: ${prUrl}\n- Base: \`${repository.defaultBranch}\`\n- Factory main unchanged: **true**\n- Merge / deploy: none\n`);
  return { publication: "draft-pr-created", prStatus: "draft-open", commitSha, prUrl };
}
