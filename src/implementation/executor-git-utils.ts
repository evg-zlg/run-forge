import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function localRefExists(repository: string, branch: string): Promise<boolean> {
  return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository }).then(
    () => true,
    (error: unknown) => { if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false; throw error; },
  );
}

export function localBranchName(taskId: string, generation: string, attempt: number): string {
  const slug = (value: string, fallback: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
  return `runforge/${slug(taskId, "task")}/${slug(generation, "standalone")}-${Number.isSafeInteger(attempt) && attempt > 0 ? `attempt-${attempt}` : "attempt-1"}`;
}
