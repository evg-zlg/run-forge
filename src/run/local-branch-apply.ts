import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AuthorityClassification, AuthorityEnvelope } from "./delegated-authority.js";

const execFileAsync = promisify(execFile);

export function evaluateLocalBranchAuthority(envelope: AuthorityEnvelope, input: { targetBranch: string; sourceBranch: string; defaultBranch: string; sourceRepo: string; worktreePath: string; sourceClean: boolean; expectedPatchHash: string; currentPatchHash: string }): { classification: AuthorityClassification; reason: string } {
  if (envelope.allowed_actions.create_or_update_local_non_main_branch !== true) return { classification: "too_narrow", reason: "Authority does not allow local non-main branch creation." };
  if (!envelope.local_branch_apply?.allowed || envelope.local_branch_apply.mode !== "local-non-main-branch") return { classification: "too_narrow", reason: "Authority lacks a bounded local branch target." };
  if (envelope.local_branch_apply.branch_name !== input.targetBranch) return { classification: "mismatched", reason: "Requested branch differs from the authority-bound branch." };
  if (input.expectedPatchHash !== input.currentPatchHash) return { classification: "stale", reason: "Patch hash changed after authority binding." };
  if (!input.sourceClean) return { classification: "stale", reason: "Source repository is dirty." };
  const target = input.targetBranch.trim();
  if (!target || ["main", "master", input.defaultBranch, input.sourceBranch].map((value) => value.toLowerCase()).includes(target.toLowerCase())) return { classification: "mismatched", reason: "Target branch is main, master, default, or the current source branch." };
  if (target.includes("..") || target.startsWith("-") || target.endsWith("/") || /[~^:?*\[\]\\\s]/.test(target)) return { classification: "invalid", reason: "Target branch name is unsafe." };
  const inside = relative(resolve(input.sourceRepo), resolve(input.worktreePath));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return { classification: "mismatched", reason: "Local branch worktree resolves inside the source worktree." };
  if (envelope.expires_at !== null && Date.parse(envelope.expires_at) <= Date.now()) return { classification: "expired", reason: "Authority expired before local branch creation." };
  return { classification: "accepted", reason: "Authority covers an explicit clean local non-main branch worktree." };
}

export async function createLocalBranchWorktree(input: { repo: string; worktree: string; branch: string; sourceHead: string; patchPath: string }): Promise<void> {
  const existing = await execFileAsync("git", ["-C", input.repo, "show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`]).then(() => true, () => false);
  if (existing) throw new Error(`Local target branch already exists: ${input.branch}. Refusing an implicit update.`);
  await mkdir(resolve(input.worktree, ".."), { recursive: true });
  await execFileAsync("git", ["-C", input.repo, "worktree", "add", "-b", input.branch, input.worktree, input.sourceHead]);
  try {
    await execFileAsync("git", ["apply", "--check", input.patchPath], { cwd: input.worktree });
    await execFileAsync("git", ["apply", input.patchPath], { cwd: input.worktree });
  } catch (error) {
    await execFileAsync("git", ["-C", input.repo, "worktree", "remove", "--force", input.worktree]).catch(() => undefined);
    await execFileAsync("git", ["-C", input.repo, "branch", "-D", input.branch]).catch(() => undefined);
    throw error;
  }
}

export async function withIsolatedGitMetadata<T>(worktree: string, action: () => Promise<T>): Promise<T> {
  const gitPath = join(worktree, ".git");
  const pointer = await readFile(gitPath, "utf8");
  await rm(gitPath, { force: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: worktree });
  try { return await action(); }
  finally { await rm(gitPath, { recursive: true, force: true }); await writeFile(gitPath, pointer, "utf8"); }
}

export async function writeLocalBranchPrPackage(out: string, input: { branch: string; worktree: string; validationPassed: boolean }): Promise<void> {
  const dir = join(out, "pr-package"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pr-title.txt"), "Document offline validation workflow\n");
  await writeFile(join(dir, "pr-body.md"), `## Summary\n\n- Document the existing offline validation workflow.\n\n## Validation\n\n- Local non-main branch validation: ${input.validationPassed ? "passed" : "failed"}\n`);
  await writeFile(join(dir, "branch-summary.md"), `# Branch Summary\n\n- Local branch: \`${input.branch}\`\n- Worktree: \`${input.worktree}\`\n- Push performed: no\n`);
  await writeFile(join(dir, "changed-files.md"), "# Changed Files\n\n- `README.md` — documentation-only offline validation guidance.\n");
  await writeFile(join(dir, "validation-summary.md"), `# Validation Summary\n\nDocker runtime network was disabled. Branch validation passed: **${input.validationPassed}**.\n`);
  await writeFile(join(dir, "risk-assessment.md"), "# Risk Assessment\n\nLow risk, documentation only. No provider, database, production, secret, deploy, push, merge, or external PR action.\n");
  await writeFile(join(dir, "manual-push-instructions.md"), `# Manual Push Instructions\n\nAfter owner review only:\n\n1. Inspect and commit the prepared change: \`git -C ${input.worktree} diff && git -C ${input.worktree} add README.md && git -C ${input.worktree} commit -m "Document offline validation workflow"\`.\n2. Publish separately: \`git -C ${input.worktree} push -u origin ${input.branch}\`.\n\nRunForge executed neither commit nor push.\n`);
  await writeFile(join(dir, "manual-create-pr-instructions.md"), "# Manual PR Instructions\n\nAfter an owner-authorized push, create the PR manually using `pr-title.txt` and `pr-body.md`.\n");
  await writeFile(join(dir, "rollback-instructions.md"), `# Rollback Instructions\n\nRemove the worktree and local branch: \`git worktree remove ${input.worktree}\`, then \`git branch -D ${input.branch}\`.\n`);
  await writeFile(join(dir, "owner-next-actions.md"), "# Owner Next Actions\n\nReview the local branch diff, validation evidence, and risk assessment. Decide separately whether publication is authorized.\n");
}
