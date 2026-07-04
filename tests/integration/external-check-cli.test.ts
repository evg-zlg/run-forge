import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("external check CLI", () => {
  it("creates a complete alpha-2.1 packet for a successful command without mutating the original repo", async () => {
    const repo = await createGitFixtureRepo();
    const before = await gitStatus(repo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-out-"));

    const result = await runCli([
      "external",
      "check",
      "--repo", repo,
      "--command", "node -e \"console.log('ok')\"",
      "--out", outDir,
      "--run-id", "external-check-success"
    ]);

    const packetDir = join(outDir, "packet");
    expect(result.stdout).toContain("Run ID: external-check-success");
    expect(result.stdout).toContain("Status: passed");
    expect(result.stdout).toContain("CLI exit policy: packet");
    expect(result.stdout).toContain(`Packet: ${packetDir}`);

    for (const file of [
      "summary.md",
      "run.json",
      "events.jsonl",
      "metrics.json",
      "command-results.json",
      "safety-report.json",
      "trajectory.json",
      "packet-manifest.json",
      "logs/command-001.stdout.log",
      "logs/command-001.stderr.log"
    ]) {
      await access(join(packetDir, file));
    }

    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      schemaVersion: string;
      runId: string;
      status: string;
      taskType: string;
      cliExitPolicy: string;
      cliExitCode: number;
      commandPolicy: { onFailure: string };
      repo: { mutationVerdict: string; statusBefore: string; statusAfter: string; baselineDirty: boolean };
      workspace: { changeSummary: { method: string; status: string; counts: { added: number; modified: number; deleted: number }; error: string | null } };
      commands: Array<{ commandId: string; status: string; exitCode: number; stdoutPath: string; stderrPath: string }>;
    };
    expect(run.schemaVersion).toBe("alpha-2.1");
    expect(run.taskType).toBe("external_command_check");
    expect(run.status).toBe("passed");
    expect(run.cliExitPolicy).toBe("packet");
    expect(run.cliExitCode).toBe(0);
    expect(run.commandPolicy.onFailure).toBe("continue");
    expect(run.repo).toMatchObject({ mutationVerdict: "unchanged", statusBefore: "", statusAfter: "", baselineDirty: false });
    expect(run.workspace.changeSummary).toMatchObject({
      method: "filesystem_snapshot",
      status: "ok",
      counts: { added: 0, modified: 0, deleted: 0 },
      error: null
    });
    expect(run.commands[0]).toMatchObject({
      status: "passed",
      exitCode: 0,
      stdoutPath: "logs/command-001.stdout.log",
      stderrPath: "logs/command-001.stderr.log"
    });

    const summary = await readFile(join(packetDir, "summary.md"), "utf8");
    expect(summary).toContain("Run ID: external-check-success");
    expect(summary).toContain("Command policy: on failure continue");
    expect(summary).toContain("Workspace changes: added 0, modified 0, deleted 0");
    expect(summary).toContain("Dependency context:");

    expect(await readFile(join(packetDir, "logs/command-001.stdout.log"), "utf8")).toContain("ok");
    expect(await gitStatus(repo)).toEqual(before);
  });

  it("records unique run ids for fast consecutive runs", async () => {
    const repo = await createGitFixtureRepo();
    const outOne = await mkdtemp(join(tmpdir(), "runforge-external-check-unique-one-"));
    const outTwo = await mkdtemp(join(tmpdir(), "runforge-external-check-unique-two-"));

    await runCli(["external", "check", "--repo", repo, "--command", "node -e \"process.exit(0)\"", "--out", outOne]);
    await runCli(["external", "check", "--repo", repo, "--command", "node -e \"process.exit(0)\"", "--out", outTwo]);

    const first = JSON.parse(await readFile(join(outOne, "packet", "run.json"), "utf8")) as { runId: string };
    const second = JSON.parse(await readFile(join(outTwo, "packet", "run.json"), "utf8")) as { runId: string };
    expect(first.runId).not.toEqual(second.runId);
  });

  it("records graph-grade events, failures, metrics, and multi-command policy", async () => {
    const repo = await createGitFixtureRepo();
    const before = await gitStatus(repo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-failure-"));

    await runCli([
      "external",
      "check",
      "--repo", repo,
      "--command", "node -e \"console.log('first')\"",
      "--command", "node -e \"console.error('boom'); process.exit(7)\"",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const results = JSON.parse(await readFile(join(packetDir, "command-results.json"), "utf8")) as {
      schemaVersion: string;
      runId: string;
      commandPolicy: { onFailure: string };
      commands: Array<{ commandId: string; command: string; status: string; exitCode: number; stdoutBytes: number; stderrBytes: number }>;
    };
    expect(results.schemaVersion).toBe("alpha-2.1");
    expect(results.commandPolicy.onFailure).toBe("continue");
    expect(results.commands).toHaveLength(2);
    expect(results.commands[0]).toMatchObject({ status: "passed", exitCode: 0 });
    expect(results.commands[1]).toMatchObject({ status: "failed", exitCode: 7 });
    expect(results.commands[0].stdoutBytes).toBeGreaterThan(0);
    expect(results.commands[1].stderrBytes).toBeGreaterThan(0);

    const metrics = JSON.parse(await readFile(join(packetDir, "metrics.json"), "utf8")) as {
      schemaVersion: string;
      runId: string;
      commandsRequested: number;
      commandsRun: number;
      commandsPassed: number;
      commandsFailed: number;
      stdoutTruncations: number;
      stderrTruncations: number;
      workspaceChanges: { added: number; modified: number; deleted: number };
      originalRepoBaselineDirty: boolean;
      originalRepoMutationVerdict: string;
      commandDurationMs: { total: number };
      commands: Array<{ commandId: string; index: number }>;
      finalStatus: string;
    };
    expect(metrics).toMatchObject({
      schemaVersion: "alpha-2.1",
      runId: results.runId,
      commandsRequested: 2,
      commandsRun: 2,
      commandsPassed: 1,
      commandsFailed: 1,
      stdoutTruncations: 0,
      stderrTruncations: 0,
      workspaceChanges: { added: 0, modified: 0, deleted: 0 },
      originalRepoBaselineDirty: false,
      originalRepoMutationVerdict: "unchanged",
      finalStatus: "failed"
    });
    expect(metrics.commandDurationMs.total).toBeGreaterThanOrEqual(0);
    expect(metrics.commands[1]?.commandId).toBe(results.commands[1]?.commandId);

    const events = readEvents(packetDir);
    expect((await events).every((event) => event.runId === results.runId && typeof event.eventId === "string")).toBe(true);
    const started = (await events).filter((event) => event.type === "command_started");
    const finished = (await events).filter((event) => event.type === "command_finished");
    expect(started.map((event) => event.commandId)).toEqual(finished.map((event) => event.commandId));
    expect((await events).find((event) => event.type === "worker_started")?.workerId)
      .toBe((await events).find((event) => event.type === "worker_finished")?.workerId);
    const artifactEvents = (await events).filter((event) => event.type === "artifact_written");
    expect(artifactEvents.length).toBeGreaterThan(0);
    expect(artifactEvents.every((event) => typeof event.artifactPath === "string" && typeof event.artifactBytes === "number")).toBe(true);
    expect((await events).find((event) => event.type === "route_selected")?.route).toBe("external_command_check");
    expect((await events).find((event) => event.type === "workspace_prepared")?.workspacePath).toBeTruthy();
    expect((await events).find((event) => event.type === "safety_check_finished")?.safetyStatus).toBe("finished");
    expect((await events).find((event) => event.type === "run_finished")?.status).toBe("failed");

    const summary = await readFile(join(packetDir, "summary.md"), "utf8");
    expect(summary).toContain("Command policy: on failure continue");
    expect(await gitStatus(repo)).toEqual(before);
  });

  it("records workspace additions with filesystem snapshot diff and no copied-workspace git error", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-mutation-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--command", "node -e \"require('fs').mkdirSync('generated', { recursive: true }); require('fs').writeFileSync('generated/out.txt', 'hello')\"",
      "--out", outDir
    ]);

    const run = JSON.parse(await readFile(join(outDir, "packet", "run.json"), "utf8")) as {
      workspace: { changeSummary: { method: string; status: string; fileChanges: { added: string[] }; counts: { added: number }; error: string | null } };
    };
    expect(run.workspace.changeSummary.method).toBe("filesystem_snapshot");
    expect(run.workspace.changeSummary.status).toBe("ok");
    expect(run.workspace.changeSummary.fileChanges.added).toContain("generated/out.txt");
    expect(run.workspace.changeSummary.counts.added).toBe(1);
    expect(run.workspace.changeSummary.error).toBeNull();
  });

  it("documents packet and command-status exit policies", async () => {
    const repo = await createGitFixtureRepo();
    const packetOut = await mkdtemp(join(tmpdir(), "runforge-external-check-packet-policy-"));
    const commandOut = await mkdtemp(join(tmpdir(), "runforge-external-check-command-policy-"));

    const packetResult = await runCli([
      "external", "check",
      "--repo", repo,
      "--command", "node -e \"process.exit(9)\"",
      "--out", packetOut
    ]);
    expect(packetResult.stdout).toContain("CLI exit code: 0");
    const packetRun = JSON.parse(await readFile(join(packetOut, "packet", "run.json"), "utf8")) as { cliExitPolicy: string; cliExitCode: number; status: string };
    expect(packetRun).toMatchObject({ status: "failed", cliExitPolicy: "packet", cliExitCode: 0 });

    const commandResult = await runCliAllowFailure([
      "external", "check",
      "--repo", repo,
      "--command", "node -e \"process.exit(9)\"",
      "--exit-policy", "command-status",
      "--out", commandOut
    ]);
    expect(commandResult.code).toBe(1);
    expect(commandResult.stdout).toContain("CLI exit policy: command-status");
    const commandRun = JSON.parse(await readFile(join(commandOut, "packet", "run.json"), "utf8")) as { cliExitPolicy: string; cliExitCode: number; status: string };
    expect(commandRun).toMatchObject({ status: "failed", cliExitPolicy: "command-status", cliExitCode: 1 });
  });

  it("records timeout wording and huge-log truncation warnings", async () => {
    const repo = await createGitFixtureRepo();
    const timeoutOut = await mkdtemp(join(tmpdir(), "runforge-external-check-timeout-"));
    const hugeOut = await mkdtemp(join(tmpdir(), "runforge-external-check-huge-"));

    await runCli([
      "external",
      "check",
      "--repo", repo,
      "--command", "node -e \"setTimeout(() => {}, 2000)\"",
      "--timeout-ms", "100",
      "--out", timeoutOut
    ]);
    const timeoutRun = JSON.parse(await readFile(join(timeoutOut, "packet", "run.json"), "utf8")) as {
      status: string;
      commands: Array<{ status: string; exitCode: number | null }>;
    };
    expect(timeoutRun.status).toBe("timed_out");
    expect(timeoutRun.commands[0]?.status).toBe("timed_out");
    expect(await readFile(join(timeoutOut, "packet", "summary.md"), "utf8")).toContain("Timeout next action:");

    await runCli([
      "external",
      "check",
      "--repo", repo,
      "--command", "node -e \"process.stdout.write('x'.repeat(1000))\"",
      "--max-log-bytes", "10",
      "--out", hugeOut
    ]);
    const hugeMetrics = JSON.parse(await readFile(join(hugeOut, "packet", "metrics.json"), "utf8")) as { stdoutTruncations: number };
    expect(hugeMetrics.stdoutTruncations).toBe(1);
    expect(await readFile(join(hugeOut, "packet", "summary.md"), "utf8")).toContain("logs were truncated");
  });

  it("adds schemaVersion to JSON artifacts", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-schema-"));

    await runCli(["external", "check", "--repo", repo, "--command", "node -e \"process.exit(0)\"", "--out", outDir]);

    for (const file of ["run.json", "metrics.json", "command-results.json", "safety-report.json", "trajectory.json", "packet-manifest.json"]) {
      const json = JSON.parse(await readFile(join(outDir, "packet", file), "utf8")) as { schemaVersion: string };
      expect(json.schemaVersion).toBe("alpha-2.1");
    }
  });
});

describe("external failure-triage CLI", () => {
  it("triages a failed external check packet with evidence-backed root cause", async () => {
    const repo = await createGitFixtureRepo();
    const checkOut = await mkdtemp(join(tmpdir(), "runforge-external-check-triage-failed-"));
    const triageOut = await mkdtemp(join(tmpdir(), "runforge-external-triage-failed-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--command", "node -e \"console.error('AssertionError: expected 1 to equal 2'); process.exit(1)\"",
      "--out", checkOut
    ]);

    const result = await runCli([
      "external", "failure-triage",
      "--from-check-packet", join(checkOut, "packet"),
      "--out", triageOut,
      "--run-id", "external-triage-failed"
    ]);

    const packetDir = join(triageOut, "packet");
    expect(result.stdout).toContain("Run ID: external-triage-failed");
    expect(result.stdout).toContain("Category: test_assertion_failure");
    for (const file of [
      "summary.md",
      "human-review.md",
      "failure-triage.md",
      "root-cause.json",
      "evidence-excerpts.md",
      "safe-next-action.md",
      "run.json",
      "events.jsonl",
      "metrics.json",
      "safety-report.json",
      "trajectory.json",
      "packet-manifest.json"
    ]) {
      await access(join(packetDir, file));
    }
    const rootCause = JSON.parse(await readFile(join(packetDir, "root-cause.json"), "utf8")) as {
      schemaVersion: string;
      category: string;
      confidence: string;
      readyForCodeProposal: boolean;
    };
    expect(rootCause).toMatchObject({
      schemaVersion: "alpha-3a",
      category: "test_assertion_failure",
      confidence: "high",
      readyForCodeProposal: true
    });
    expect(await readFile(join(packetDir, "evidence-excerpts.md"), "utf8")).toContain("AssertionError");
  });

  it("triages a timeout packet as timeout and keeps code proposal gated", async () => {
    const repo = await createGitFixtureRepo();
    const checkOut = await mkdtemp(join(tmpdir(), "runforge-external-check-triage-timeout-"));
    const triageOut = await mkdtemp(join(tmpdir(), "runforge-external-triage-timeout-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--command", "node -e \"setTimeout(() => {}, 2000)\"",
      "--timeout-ms", "100",
      "--out", checkOut
    ]);

    await runCli([
      "external", "failure-triage",
      "--from-check-packet", join(checkOut, "packet"),
      "--out", triageOut
    ]);

    const rootCause = JSON.parse(await readFile(join(triageOut, "packet", "root-cause.json"), "utf8")) as {
      category: string;
      confidence: string;
      requiresMoreContext: boolean;
      readyForCodeProposal: boolean;
    };
    expect(rootCause).toMatchObject({
      category: "timeout",
      confidence: "high",
      requiresMoreContext: true,
      readyForCodeProposal: false
    });
  });

  it("reports no_failure_observed for a passed packet", async () => {
    const repo = await createGitFixtureRepo();
    const triageOut = await mkdtemp(join(tmpdir(), "runforge-external-triage-passed-"));

    await runCli([
      "external", "failure-triage",
      "--repo", repo,
      "--command", "node -e \"console.log('ok')\"",
      "--out", triageOut
    ]);

    const run = JSON.parse(await readFile(join(triageOut, "packet", "run.json"), "utf8")) as {
      status: string;
      category: string;
      sourceCheckStatus: string;
      readyForCodeProposal: boolean;
    };
    expect(run).toMatchObject({
      status: "no_failure_observed",
      category: "no_failure_observed",
      sourceCheckStatus: "passed",
      readyForCodeProposal: false
    });
    await access(join(triageOut, "check-source", "packet", "run.json"));
  });
});

function runCli(args: string[]) {
  return execFileAsync("pnpm", ["exec", "tsx", "src/cli/index.ts", ...args], {
    cwd: resolve("."),
    maxBuffer: 1024 * 1024
  });
}

async function runCliAllowFailure(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    const result = await runCli(args);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code: number | null; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

async function readEvents(packetDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(packetDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function createGitFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-external-check-repo-"));
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "external-check-fixture", scripts: { ok: "node -e \"console.log('ok')\"" } }, null, 2), "utf8");
  await writeFile(join(repo, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Test", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

async function gitStatus(repo: string): Promise<string> {
  const result = await execFileAsync("git", ["status", "--short"], { cwd: repo });
  return result.stdout.trim();
}
