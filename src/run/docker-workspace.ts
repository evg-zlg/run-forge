import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

const dockerMountDelimiter = /[,=\u0000-\u001f\u007f]/;

/** Docker's --mount value is comma-delimited and has no argv-level escaping for path fields. */
export function assertDockerMountPath(path: string, label: string): string {
  if (!path || dockerMountDelimiter.test(path)) throw new Error(`${label} contains characters unsafe for Docker --mount grammar.`);
  return path;
}

export function assertDockerVolumeName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Docker temporary volume name is unsafe for --mount grammar.");
  return name;
}

export function resolveDockerWorkspace(input: { cwd: string; dockerWorkspace?: { root: string; workingDirectory: string } }): { root: string; workdir: string } {
  if (!input.dockerWorkspace) return { root: resolve(assertDockerMountPath(input.cwd, "Docker workspace root")), workdir: "/workspace" };
  const { root, workingDirectory } = input.dockerWorkspace;
  assertDockerMountPath(root, "Docker workspace root"); assertDockerMountPath(workingDirectory, "Docker workspace workingDirectory");
  if (!workingDirectory || isAbsolute(workingDirectory) || win32.isAbsolute(workingDirectory)) throw new Error("Docker workspace workingDirectory must be a relative path inside the workspace root.");
  const absoluteRoot = resolve(root), executionRoot = resolve(absoluteRoot, workingDirectory), child = relative(absoluteRoot, executionRoot);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Docker workspace workingDirectory escapes the workspace root.");
  return { root: assertDockerMountPath(absoluteRoot, "Docker workspace root"), workdir: assertDockerMountPath(child ? `/workspace/${child.split(sep).join("/")}` : "/workspace", "Docker container workdir") };
}
