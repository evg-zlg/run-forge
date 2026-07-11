import { access, cp, mkdir, symlink } from "node:fs/promises";
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

export async function prepareUnpreparedExternalWorkspace(sourceRepo: string, workspace: string): Promise<void> {
  await mkdir(`${workspace}/.runforge-tmp`, { recursive: true });
  const dependenciesExist = await access(`${sourceRepo}/node_modules`).then(() => true).catch(() => false);
  if (dependenciesExist) await symlink("/source/node_modules", `${workspace}/node_modules`, "dir");
}

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
