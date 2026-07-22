import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { withDockerValidationTempVolume } from "../../src/run/docker-validation-temp-volume.js";
import { createExecutorRequest, dockerRunArgs, LocalShellExecutor } from "../../src/run/task-run-executor.js";
import { prepareUnpreparedExternalWorkspace } from "../../src/run/task-run-workspace.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DockerShellExecutor policy", () => {
  it("creates the writable temp mount under a nested execution root", async () => {
    const source = await tempRoot();
    const workspace = await tempRoot();
    await mkdir(join(source, "frontend"));

    await prepareUnpreparedExternalWorkspace(source, workspace, "frontend");

    await expect(access(join(workspace, "frontend"))).resolves.toBeUndefined();
  });

  it("builds an offline, read-only, capability-dropped container command", async () => {
    const root = await tempRoot();
    const request = createExecutorRequest({
      runId: "TASK-RUN-7",
      subtaskId: "01-container",
      command: "rg -n runtime src",
      cwd: root,
      artifactDir: join(root, "subtasks", "01-container"),
      lane: "docker-shell"
    });

    const args = dockerRunArgs(request, "runforge:local", "runforge-test");

    expect(request.id).toContain("docker-shell");
    expect(args).toEqual(expect.arrayContaining([
      "--pull", "never",
      "--network", "none",
      "--cap-drop", "ALL",
      "--cpus", "4",
      "--user", `${process.getuid?.() ?? 65_534}:${process.getgid?.() ?? 65_534}`,
      "--read-only",
      "--entrypoint", "/bin/sh",
      "runforge:local",
      "rg -n runtime src"
    ]));
    expect(args.find((item) => item.startsWith("type=bind"))).toContain("readonly");
  });

  it("mounts the autonomous repository root while starting in a contained monorepo package", async () => {
    const root = await tempRoot(), cwd = join(root, "packages", "app"); await mkdir(cwd, { recursive: true });
    const request = createExecutorRequest({ runId: "MONOREPO-1", subtaskId: "validation", command: "git status --short", cwd, artifactDir: join(root, "artifacts"), lane: "docker-shell", dockerWorkspace: { root, workingDirectory: "packages/app" } });
    const args = dockerRunArgs(request, "runforge:test", "monorepo-validation", true);
    expect(args).toContain(`type=bind,src=${root},dst=/workspace`);
    expect(args).toEqual(expect.arrayContaining(["--workdir", "/workspace/packages/app", "COREPACK_HOME=/workspace/packages/app/.runforge-corepack"]));
    const dependencyArgs = dockerRunArgs(request, "runforge:test", "monorepo-dependencies", true, undefined, undefined, "/private/task-dependencies");
    expect(dependencyArgs).toContain("type=bind,src=/private/task-dependencies,dst=/workspace/packages/app/node_modules");
    expect(dependencyArgs).not.toContain("type=bind,src=/private/task-dependencies,dst=/workspace/packages/app/node_modules,readonly");
    for (const workingDirectory of ["../escape", "/absolute", "C:\\absolute"]) {
      const unsafe = createExecutorRequest({ runId: "MONOREPO-1", subtaskId: "unsafe", command: "true", cwd, artifactDir: join(root, "unsafe"), dockerWorkspace: { root, workingDirectory } });
      expect(() => dockerRunArgs(unsafe, "runforge:test", "unsafe", true)).toThrow(/relative path|escapes/i);
    }
  });

  it("rejects mount-grammar delimiters and control characters in repository, package, dependency, and volume sources", async () => {
    const root = await tempRoot(), cwd = join(root, "packages", "app"); await mkdir(cwd, { recursive: true });
    const request = (workspaceRoot: string, workingDirectory: string) => createExecutorRequest({ runId: "MOUNT-GRAMMAR", subtaskId: "unsafe", command: "true", cwd, artifactDir: join(root, "artifacts"), dockerWorkspace: { root: workspaceRoot, workingDirectory } });
    for (const unsafeRoot of [`${root},readonly`, `${root}=injected`, `${root}\n--mount`]) {
      expect(() => dockerRunArgs(request(unsafeRoot, "packages/app"), "runforge:test", "unsafe", true)).toThrow(/mount grammar/i);
    }
    for (const unsafePackage of ["packages/app,readonly", "packages/app=dst", "packages/app\n--mount"]) {
      expect(() => dockerRunArgs(request(root, unsafePackage), "runforge:test", "unsafe", true)).toThrow(/mount grammar/i);
    }
    const safe = request(root, "packages/app");
    for (const unsafeDependency of ["/private/deps,readonly", "/private/deps=dst", "/private/deps\n--mount"]) {
      expect(() => dockerRunArgs(safe, "runforge:test", "unsafe", true, unsafeDependency)).toThrow(/mount grammar/i);
      expect(() => dockerRunArgs(safe, "runforge:test", "unsafe", true, undefined, undefined, unsafeDependency)).toThrow(/mount grammar/i);
    }
    expect(() => dockerRunArgs(safe, "runforge:test", "unsafe", true, undefined, "volume,readonly")).toThrow(/mount grammar/i);
  });

  it("allows writes only when the caller declares a disposable prepared workspace", async () => {
    const root = await tempRoot();
    const request = createExecutorRequest({
      runId: "EXTERNAL-RUN-3",
      subtaskId: "03-build",
      command: "npm run build",
      cwd: root,
      artifactDir: join(root, "subtasks", "03-build"),
      lane: "docker-shell"
    });

    const args = dockerRunArgs(request, "runforge:local", "runforge-test", true);
    const validationTmpfs = "/runforge-tmp:rw,nosuid,nodev,size=512m,mode=1777";

    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--cpus", "4", "--user", `${process.getuid?.() ?? 65_534}:${process.getgid?.() ?? 65_534}`, "--read-only", "--memory", "2g", "HOME=/tmp", "COREPACK_HOME=/workspace/.runforge-corepack", "TMPDIR=/runforge-tmp"]));
    expect(args[args.indexOf(validationTmpfs) - 1]).toBe("--tmpfs");
    expect(args).not.toContain(`type=bind,src=${root}/.runforge-tmp,dst=/runforge-tmp`);
    expect(args.filter((item) => item.startsWith("type=bind"))).not.toEqual(expect.arrayContaining([expect.stringContaining("dst=/runforge-tmp")]));
    expect(args.find((item) => item.startsWith("type=bind"))).not.toContain("readonly");
  });

  it("shares a bounded validation volume and removes it when evidence finalization fails", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    const log = join(root, "docker.log");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
    await chmod(join(bin, "docker"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await expect(withDockerValidationTempVolume("VALIDATION Run/1", async (volume) => {
        expect(volume).toMatch(/^runforge-validation-tmp-validation-run-1-[a-f0-9]{16}$/);
        const request = createExecutorRequest({ runId: "RUN", subtaskId: "one", command: "true", cwd: root, artifactDir: join(root, "artifacts") });
        const first = dockerRunArgs(request, "runforge:test", "one", true, undefined, volume);
        const second = dockerRunArgs(request, "runforge:test", "two", true, undefined, volume);
        expect(first).toContain(`type=volume,src=${volume},dst=/runforge-tmp`);
        expect(second).toContain(`type=volume,src=${volume},dst=/runforge-tmp`);
        expect(first.join(" ")).not.toContain("noexec");
        throw new Error("evidence finalization failed");
      })).rejects.toThrow("evidence finalization failed");
      const lifecycle = await readFile(log, "utf8");
      expect(lifecycle).toContain(`volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=536870912,mode=1777,uid=${process.getuid?.() ?? 65_534},gid=${process.getgid?.() ?? 65_534},nosuid,nodev runforge-validation-tmp-validation-run-1-`);
      expect(lifecycle).toMatch(/volume rm -f runforge-validation-tmp-validation-run-1-[a-f0-9]{16}/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });

  it("preserves no-preparation triage with a resolving node_modules-only read-only mount", async () => {
    const root = await tempRoot();
    const request = createExecutorRequest({
      runId: "EXTERNAL-RUN-2",
      subtaskId: "01-external-validation",
      command: "node --version",
      cwd: root,
      artifactDir: join(root, "subtasks", "01-external-validation"),
      lane: "docker-shell"
    });

    const args = dockerRunArgs(request, "runforge:local", "runforge-test", true, "/external/source");

    expect(args).toContain("type=bind,src=/external/source,dst=/workspace/node_modules,readonly");
    expect(args).not.toContain("type=bind,src=/external/source,dst=/source,readonly");
    expect(args).toEqual(expect.arrayContaining(["--network", "none"]));
  });
});

describe("LocalShellExecutor", () => {
  it("captures stdout, stderr, status, and artifact paths for a passing executor request", async () => {
    const root = await tempRoot();
    const artifactDir = join(root, "subtasks", "01-demo");
    const executor = new LocalShellExecutor(root);

    const result = await executor.execute(
      createExecutorRequest({
        runId: "AGENT-OS-3-TEST",
        subtaskId: "01-demo",
        command: "printf 'hello executor\\n' && printf 'diagnostic\\n' >&2",
        cwd: root,
        artifactDir
      })
    );

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.executor).toBe("local-shell");
    expect(result.stdout).toContain("hello executor");
    expect(result.stderr).toContain("diagnostic");
    await expect(readFile(join(artifactDir, "command.log"), "utf8")).resolves.toContain("executor: local-shell");
    await expect(readFile(join(artifactDir, "stdout.log"), "utf8")).resolves.toContain("hello executor");
    await expect(readFile(join(artifactDir, "stderr.log"), "utf8")).resolves.toContain("diagnostic");
    await expect(readFile(join(artifactDir, "executor-report.json"), "utf8")).resolves.toContain('"status": "passed"');
  });

  it("records failed shell commands without throwing", async () => {
    const root = await tempRoot();
    const executor = new LocalShellExecutor(root);

    const result = await executor.execute(
      createExecutorRequest({
        runId: "AGENT-OS-3-TEST",
        subtaskId: "02-fail",
        command: "printf 'bad path\\n' >&2; exit 7",
        cwd: root,
        artifactDir: join(root, "subtasks", "02-fail")
      })
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("bad path");
  });

  it("uses artifact-owned runtime directories without forwarding hostile host HOME or TMPDIR", async () => {
    const root = await tempRoot();
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;
    const hostHome = join(root, "host-home-must-not-leak");
    const hostileTmpdir = join(hostHome, "host-tmp-must-not-leak");
    const artifactDir = join(root, "subtasks", "03-controlled-home");
    process.env.HOME = hostHome;
    process.env.TMPDIR = hostileTmpdir;
    await mkdir(hostileTmpdir, { recursive: true });

    try {
      const executor = new LocalShellExecutor(root, true);
      const result = await executor.execute(
        createExecutorRequest({
          runId: "AGENT-OS-3-TEST",
          subtaskId: "03-controlled-home",
          command: "node -e 'process.stdout.write(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cache: process.env.npm_config_cache }))'",
          cwd: root,
          artifactDir
        })
      );

      expect(result.status).toBe("passed");
      expect(JSON.parse(result.stdout)).toEqual({
        home: join(artifactDir, "runtime", "home"),
        tmp: join(artifactDir, "runtime", "tmp"),
        cache: join(artifactDir, "runtime", "npm-cache")
      });
      expect(result.stdout).not.toContain(hostHome);
      expect(result.stdout).not.toContain(hostileTmpdir);
      await expect(access(join(artifactDir, "runtime", "home"))).resolves.toBeUndefined();
      await expect(access(join(artifactDir, "runtime", "tmp"))).resolves.toBeUndefined();
      await expect(access(join(artifactDir, "runtime", "npm-cache"))).resolves.toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    }
  });

  it("isolates controlled runtime directories between executions", async () => {
    const root = await tempRoot();
    const executor = new LocalShellExecutor(root, true);
    const firstArtifactDir = join(root, "subtasks", "04-first");
    const secondArtifactDir = join(root, "subtasks", "05-second");

    const first = await executor.execute(createExecutorRequest({
      runId: "AGENT-OS-3-TEST",
      subtaskId: "04-first",
      command: "printf first > \"$HOME/marker\"; node -e 'process.stdout.write(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cache: process.env.npm_config_cache }))'",
      cwd: root,
      artifactDir: firstArtifactDir
    }));
    const second = await executor.execute(createExecutorRequest({
      runId: "AGENT-OS-3-TEST",
      subtaskId: "05-second",
      command: "test ! -e \"$HOME/marker\"; node -e 'process.stdout.write(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cache: process.env.npm_config_cache }))'",
      cwd: root,
      artifactDir: secondArtifactDir
    }));

    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    expect(JSON.parse(first.stdout)).toEqual({
      home: join(firstArtifactDir, "runtime", "home"),
      tmp: join(firstArtifactDir, "runtime", "tmp"),
      cache: join(firstArtifactDir, "runtime", "npm-cache")
    });
    expect(JSON.parse(second.stdout)).toEqual({
      home: join(secondArtifactDir, "runtime", "home"),
      tmp: join(secondArtifactDir, "runtime", "tmp"),
      cache: join(secondArtifactDir, "runtime", "npm-cache")
    });
    await expect(readFile(join(firstArtifactDir, "runtime", "home", "marker"), "utf8")).resolves.toBe("first");
    await expect(access(join(secondArtifactDir, "runtime", "home", "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runforge-executor-test-"));
  tempRoots.push(root);
  return root;
}
