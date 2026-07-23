import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparationDockerArgs, prepareExternalRuntime } from "../../src/run/runtime-preparation.js";
import { planExternalValidationTaskRun } from "../../src/run/task-run-planner.js";
import { createExecutorRequest, dockerRunArgs } from "../../src/run/task-run-executor.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("external runtime preparation policy", () => {
  it("keeps network-enabled preparation explicit, bounded, and separate from execution", () => {
    const args = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "npm ci --ignore-scripts");

    expect(args).toEqual(expect.arrayContaining([
      "--pull", "never",
      "--network", "bridge",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--env", "COREPACK_HOME=/workspace/.runforge-corepack",
      "--entrypoint", "/bin/sh",
      "runforge:local"
    ]));
    expect(args.at(-1)).toContain("npm ci --ignore-scripts");
  });

  it("prepares dependencies from the nested execution root", () => {
    const args = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "corepack yarn install --immutable", "frontend");
    expect(args).toContain("/workspace/frontend");
    expect(args).toContain("COREPACK_HOME=/workspace/frontend/.runforge-corepack");
  });

  it("rejects mount-grammar delimiters and control characters before required dependency preparation", () => {
    for (const unsafeWorkspace of ["/tmp/prepared,readonly", "/tmp/prepared=dst", "/tmp/prepared\n--mount"]) {
      expect(() => preparationDockerArgs(unsafeWorkspace, "runforge:local", "prepare-test", "npm ci", "packages/app")).toThrow(/mount grammar/i);
    }
    for (const unsafePackage of ["packages/app,readonly", "packages/app=dst", "packages/app\n--mount"]) {
      expect(() => preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "npm ci", unsafePackage)).toThrow(/mount grammar/i);
    }
  });

  it("persists Corepack only in the disposable workspace for offline validation", () => {
    const previous = process.env.COREPACK_HOME; process.env.COREPACK_HOME = "/host/private/corepack-cache";
    try {
      const prep = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "corepack pnpm install --frozen-lockfile");
      const request = createExecutorRequest({ runId: "CACHE-1", subtaskId: "validation", command: "corepack pnpm test", cwd: "/tmp/prepared", artifactDir: "/tmp/artifacts", lane: "docker-shell" });
      const validation = dockerRunArgs(request, "runforge:local", "validation-test", true);
      expect(prep).toContain("COREPACK_HOME=/workspace/.runforge-corepack");
      expect(validation).toContain("COREPACK_HOME=/workspace/.runforge-corepack");
      expect(prep).toEqual(expect.arrayContaining(["--network", "bridge"]));
      expect(validation).toEqual(expect.arrayContaining(["--network", "none"]));
      expect(`${prep.join(" ")} ${validation.join(" ")}`).not.toContain("/host/private/corepack-cache");
    } finally { if (previous === undefined) delete process.env.COREPACK_HOME; else process.env.COREPACK_HOME = previous; }
  });

  it("normalizes only dependency/runtime permissions while preserving read-only autonomous Git objects and repository files", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-required-permissions-"))) - 1]!;
    const repository = join(root, "source"), workspace = join(root, "workspace"), artifacts = join(root, "artifacts"), bin = join(root, "bin");
    await mkdir(repository); await mkdir(artifacts); await mkdir(bin);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository }); execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "immutable fixture\n"); await writeFile(join(repository, "package.json"), "{\"packageManager\":\"pnpm@10.0.0\"}\n"); await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["add", "."], { cwd: repository }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository }); execFileSync("git", ["gc", "--quiet"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), docker = join(bin, "docker"), dockerLog = join(root, "docker.log");
    await writeFile(docker, `#!/bin/sh
if test "$1" = "image"; then printf 'sha256:fixture amd64\\n'; exit 0; fi
workspace=""; last=""
for argument in "$@"; do case "$argument" in type=bind,src=*,dst=/workspace) workspace="\${argument#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace}" ;; esac; last="$argument"; done
printf '%s\\n' "$last" > "${dockerLog}"
case "$last" in *'chmod -R a+rwX /workspace'*) exit 87 ;; esac
pack_count=$(find "$workspace/.git/objects/pack" -type f | wc -l | tr -d ' ')
test "$pack_count" -gt 0 || exit 88
find "$workspace/.git/objects/pack" -type f -exec chmod 444 {} +
chmod 444 "$workspace/README.md"
mkdir -p "$workspace/node_modules/fixture" "$workspace/.runforge-corepack" "$workspace/.runforge-pnpm-store" "$workspace/.runforge-tmp"
chmod -R 500 "$workspace/node_modules" "$workspace/.runforge-corepack" "$workspace/.runforge-pnpm-store" "$workspace/.runforge-tmp"
find "$workspace" -type d -name node_modules -prune -exec chmod -R a+rwX {} +
chmod -R a+rwX "$workspace/.runforge-corepack" "$workspace/.runforge-pnpm-store" "$workspace/.runforge-tmp"
`); await chmod(docker, 0o755);
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await expect(prepareExternalRuntime({ repo: repository, workspace, outDir: artifacts, image: "runforge:test", gitSnapshot: { expectedSha: head } })).resolves.toMatchObject({ status: "prepared", linuxCompatibleDependenciesCreated: true });
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim()).toBe(head);
    expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("");
    const packs = await readdir(join(workspace, ".git", "objects", "pack")); expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) expect((await stat(join(workspace, ".git", "objects", "pack", pack))).mode & 0o222).toBe(0);
    expect((await stat(join(workspace, "README.md"))).mode & 0o222).toBe(0);
    expect((await stat(join(workspace, "node_modules", "fixture"))).mode & 0o200).toBeTruthy();
    await expect(access(join(workspace, ".runforge-pnpm-store"))).resolves.toBeUndefined();
    expect(await readFile(dockerLog, "utf8")).toEqual(expect.stringContaining("corepack pnpm install --frozen-lockfile"));
    expect(await readFile(dockerLog, "utf8")).toContain("find /workspace -type d -name node_modules");
  });

  it("plans the required validation commands for the detected package manager", () => {
    expect(planExternalValidationTaskRun("validate", "package-lock.json").subtasks.map((item) => item.evidenceCommand)).toEqual([
      "npm run typecheck", "npm test", "npm run build"
    ]);
    expect(planExternalValidationTaskRun("validate", "pnpm-lock.yaml").subtasks[1]?.evidenceCommand).toBe("corepack pnpm test");
    expect(planExternalValidationTaskRun("triage", "package-lock.json", ["node --version"]).subtasks.map((item) => item.evidenceCommand)).toEqual(["node --version"]);
  });
});
