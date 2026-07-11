import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutorRequest, LocalShellExecutor } from "../../src/run/task-run-executor.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runforge-executor-test-"));
  tempRoots.push(root);
  return root;
}
