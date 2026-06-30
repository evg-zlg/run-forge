import { homedir } from "node:os";
import { resolve } from "node:path";

export function isPathInside(child: string, parent: string): boolean {
  const childPath = resolve(child);
  const parentPath = resolve(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

export function detectsHomeAccess(repoPath: string): boolean {
  return isPathInside(homedir(), resolve(repoPath));
}

export function defaultWorkspacePolicy() {
  return {
    writeRepo: false as const,
    writeArtifacts: true as const,
    runCommands: false as const
  };
}
