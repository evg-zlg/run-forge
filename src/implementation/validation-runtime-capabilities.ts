import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { packageManagerInvocation, type PackageManagerId } from "../validation/capability-contract.js";

const execFileAsync = promisify(execFile);

/** Collects conservative filesystem and executable evidence before package validation is planned. */
export async function detectPackageValidationCapabilities(input: {
  commands: readonly string[];
  executionRoot: string;
  workspaceRoot: string;
  commandAvailable?: (command: string) => Promise<boolean>;
}): Promise<{ packageManager: boolean; dependencies: boolean }> {
  const invocations = input.commands.map(packageManagerInvocation).filter((item): item is NonNullable<typeof item> => item !== null);
  if (!invocations.length) return { packageManager: false, dependencies: false };
  const supportedManagers = await projectPackageManagers(input.executionRoot, input.workspaceRoot);
  const commandAvailable = input.commandAvailable ?? executableAvailable;
  const packageManager = (await Promise.all(invocations.map(async ({ manager, launcher }) =>
    supportedManagers.has(manager) && await commandAvailable(launcher)))).every(Boolean);
  const dependencies = (await Promise.all([
    pathAvailable(join(input.executionRoot, "node_modules")),
    pathAvailable(join(input.executionRoot, ".pnp.cjs")),
    pathAvailable(join(input.executionRoot, ".pnp.loader.mjs")),
  ])).some(Boolean);
  return { packageManager, dependencies };
}

async function projectPackageManagers(executionRoot: string, workspaceRoot: string): Promise<Set<PackageManagerId>> {
  const managers = new Set<PackageManagerId>();
  let directory = executionRoot;
  let packageProjectFound = false;
  while (isInside(workspaceRoot, directory)) {
    const packageJson = await readFile(join(directory, "package.json"), "utf8").then((value) => value, () => null);
    if (packageJson !== null) {
      packageProjectFound = true;
      try {
        const declared = JSON.parse(packageJson) as { packageManager?: unknown };
        if (typeof declared.packageManager === "string") {
          const manager = /^(pnpm|npm|yarn|bun)@/.exec(declared.packageManager)?.[1] as PackageManagerId | undefined;
          if (manager) managers.add(manager);
        }
      } catch { /* TaskSpec normalization reports malformed project metadata elsewhere. */ }
    }
    const markers: Array<[PackageManagerId, string[]]> = [
      ["pnpm", ["pnpm-lock.yaml"]], ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
      ["yarn", ["yarn.lock"]], ["bun", ["bun.lock", "bun.lockb"]],
    ];
    for (const [manager, files] of markers) if ((await Promise.all(files.map((file) => pathAvailable(join(directory, file))))).some(Boolean)) managers.add(manager);
    if (directory === workspaceRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (packageProjectFound && managers.size === 0) managers.add("npm");
  return managers;
}

async function executableAvailable(command: string): Promise<boolean> {
  if (command.includes("/")) return pathAvailable(command);
  return execFileAsync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]).then(() => true, () => false);
}
async function pathAvailable(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
function isInside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); }
