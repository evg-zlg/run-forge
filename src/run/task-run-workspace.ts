import { access, cp, mkdir, symlink } from "node:fs/promises";
import { relative } from "node:path";

export async function copyTaskRunWorkspace(repoRoot: string, workspace: string, outPath: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await cp(repoRoot, workspace, {
    recursive: true,
    filter: (source) => {
      const path = relative(repoRoot, source);
      if (!path) return true;
      if (isSensitiveWorkspacePath(path)) return false;
      if (outPath && (path === outPath || path.startsWith(`${outPath}/`))) return false;
      const first = path.split("/")[0];
      return !["node_modules", "dist", ".git", ".runforge", "artifacts", "runforge-artifacts"].includes(first!);
    }
  });
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => [".ssh", ".gnupg", ".kube", ".azure"].includes(part))) return true;
  if (parts.includes(".aws") && name === "credentials") return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  return [".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name);
}

export async function prepareUnpreparedExternalWorkspace(sourceRepo: string, workspace: string, workingDirectory = "."): Promise<void> {
  await mkdir(`${workspace}/.runforge-tmp`, { recursive: true });
  await mkdir(`${workspace}/${workingDirectory}/.runforge-tmp`, { recursive: true });
  const dependenciesExist = await access(`${sourceRepo}/${workingDirectory}/node_modules`).then(() => true).catch(() => false);
  if (dependenciesExist) await symlink("/source/node_modules", `${workspace}/${workingDirectory}/node_modules`, "dir");
}

export function taskRunSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
