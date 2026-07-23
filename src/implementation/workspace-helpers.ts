import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function localRefExists(repository: string, branch: string): Promise<boolean> {
  return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository })
    .then(() => true, (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
      throw error;
    });
}

export function localBranchName(taskId: string, generation: string, attempt: number): string {
  const task = refSlug(taskId, "task");
  const execution = refSlug(generation, "standalone");
  const retry = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return `runforge/${task}/${execution}-attempt-${retry}`;
}

export function refSlug(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

export function addedPatchLines(patch: string): string {
  const added: string[] = [];
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) { inHunk = false; continue; }
    if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}
