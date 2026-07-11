import { cp, mkdir } from "node:fs/promises";
import { relative } from "node:path";

export async function copyTaskRunWorkspace(repoRoot: string, workspace: string, outPath: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await cp(repoRoot, workspace, {
    recursive: true,
    filter: (source) => {
      const path = relative(repoRoot, source);
      if (!path) return true;
      if (outPath && (path === outPath || path.startsWith(`${outPath}/`))) return false;
      const first = path.split("/")[0];
      return !["node_modules", "dist", ".git", ".runforge", "artifacts", "runforge-artifacts"].includes(first!);
    }
  });
}

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
