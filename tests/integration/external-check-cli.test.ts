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

  it("runs explicit setup commands in the disposable workspace before main commands", async () => {
    const repo = await createGitFixtureRepo();
    const before = await gitStatus(repo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-setup-pass-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--setup-command", "node -e \"require('fs').writeFileSync('prepared.txt', 'ready')\"",
      "--command", "node -e \"console.log(require('fs').readFileSync('prepared.txt', 'utf8'))\"",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    await access(join(packetDir, "setup-results.json"));
    await access(join(packetDir, "logs/setup-001.stdout.log"));
    await access(join(packetDir, "logs/setup-001.stderr.log"));
    const setupResults = JSON.parse(await readFile(join(packetDir, "setup-results.json"), "utf8")) as {
      commands: Array<{ phase: string; status: string; stdoutPath: string; stderrPath: string }>;
    };
    expect(setupResults.commands[0]).toMatchObject({
      phase: "setup",
      status: "passed",
      stdoutPath: "logs/setup-001.stdout.log",
      stderrPath: "logs/setup-001.stderr.log"
    });
    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      status: string;
      setupCommands: Array<{ phase: string; status: string }>;
      commands: Array<{ phase: string; status: string }>;
    };
    expect(run.status).toBe("passed");
    expect(run.setupCommands[0]).toMatchObject({ phase: "setup", status: "passed" });
    expect(run.commands[0]).toMatchObject({ phase: "main", status: "passed" });
    const metrics = JSON.parse(await readFile(join(packetDir, "metrics.json"), "utf8")) as {
      setupCommandsRequested: number;
      setupCommandsRun: number;
      setupCommandsPassed: number;
      setupCommandsFailed: number;
      commandsRun: number;
      commands: Array<{ phase: string }>;
    };
    expect(metrics).toMatchObject({
      setupCommandsRequested: 1,
      setupCommandsRun: 1,
      setupCommandsPassed: 1,
      setupCommandsFailed: 0,
      commandsRun: 1
    });
    expect(metrics.commands.map((command) => command.phase)).toEqual(["setup", "main"]);
    const safety = JSON.parse(await readFile(join(packetDir, "safety-report.json"), "utf8")) as {
      setupCommandsUserProvided: boolean;
      originalRepoMutationAllowed: boolean;
      setupMayUseNetwork: string;
      setupPolicy: { networkIntent: string; continueAfterSetupFailure: boolean; mainCommandsSkippedOnSetupFailure: boolean };
      originalRepoMutationVerdict: string;
    };
    expect(safety).toMatchObject({
      setupCommandsUserProvided: true,
      originalRepoMutationAllowed: false,
      originalRepoMutationVerdict: "unchanged"
    });
    expect(["unknown", "yes", "no"]).toContain(safety.setupMayUseNetwork);
    expect(safety.setupPolicy).toMatchObject({
      networkIntent: "unknown",
      continueAfterSetupFailure: false,
      mainCommandsSkippedOnSetupFailure: true
    });
    expect(await readFile(join(packetDir, "logs/command-001.stdout.log"), "utf8")).toContain("ready");
    await expect(access(join(repo, "prepared.txt"))).rejects.toThrow();
    expect(await gitStatus(repo)).toEqual(before);
  });

  it("records declared setup network intent in packet policy surfaces", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-setup-intent-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--setup-command", "node -e \"console.log('setup ok')\"",
      "--setup-network-intent", "expected",
      "--command", "node -e \"console.log('main ok')\"",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      setupPolicy: { networkIntent: string; continueAfterSetupFailure: boolean; mainCommandsSkippedOnSetupFailure: boolean };
    };
    expect(run.setupPolicy).toMatchObject({
      networkIntent: "expected",
      continueAfterSetupFailure: false,
      mainCommandsSkippedOnSetupFailure: true
    });
    const metrics = JSON.parse(await readFile(join(packetDir, "metrics.json"), "utf8")) as {
      setupNetworkIntent: string;
      setupPolicy: { networkIntent: string };
    };
    expect(metrics.setupNetworkIntent).toBe("expected");
    expect(metrics.setupPolicy.networkIntent).toBe("expected");
    const safety = JSON.parse(await readFile(join(packetDir, "safety-report.json"), "utf8")) as {
      setupNetworkIntentEnforced: boolean;
      setupPolicy: { networkIntent: string };
      setupPolicyNotes: string[];
    };
    expect(safety.setupPolicy.networkIntent).toBe("expected");
    expect(safety.setupNetworkIntentEnforced).toBe(false);
    expect(safety.setupPolicyNotes.join("\n")).toContain("does not enforce network blocking");
    const summary = await readFile(join(packetDir, "summary.md"), "utf8");
    expect(summary).toContain("Setup policy:");
    expect(summary).toContain("Network intent: expected");
  });

  it("records setup failure and skips main commands by default", async () => {
    const repo = await createGitFixtureRepo();
    const before = await gitStatus(repo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-setup-fail-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--setup-command", "node -e \"console.error('setup dependency missing'); process.exit(3)\"",
      "--command", "node -e \"require('fs').writeFileSync('should-not-run.txt', 'bad')\"",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      status: string;
      setupCommands: Array<{ status: string; phase: string }>;
      commands: Array<unknown>;
    };
    expect(run.status).toBe("setup_failed");
    expect(run.setupCommands[0]).toMatchObject({ phase: "setup", status: "failed" });
    expect(run.commands).toHaveLength(0);
    await expect(access(join(packetDir, "logs/command-001.stdout.log"))).rejects.toThrow();
    const events = await readEvents(packetDir);
    expect(events.some((event) => event.type === "setup_started")).toBe(true);
    expect(events.some((event) => event.type === "setup_finished" && event.status === "setup_failed")).toBe(true);
    expect(events.some((event) => event.type === "setup_skipped_main_commands")).toBe(true);
    const summary = await readFile(join(packetDir, "summary.md"), "utf8");
    expect(summary).toContain("Setup:");
    expect(summary).toContain("Main commands skipped.");
    expect(summary).toContain("Setup next action:");
    const metrics = JSON.parse(await readFile(join(packetDir, "metrics.json"), "utf8")) as { commandsRequested: number; commandsRun: number };
    expect(metrics).toMatchObject({ commandsRequested: 1, commandsRun: 0 });
    expect(await gitStatus(repo)).toEqual(before);
    await expect(access(join(repo, "should-not-run.txt"))).rejects.toThrow();
  });

  it("runs main commands diagnostically after setup failure only when explicitly enabled", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-setup-diagnostic-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--setup-command", "node -e \"console.error('setup failed'); process.exit(2)\"",
      "--continue-after-setup-failure",
      "--command", "node -e \"console.log('diagnostic main ran')\"",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      status: string;
      setupPolicy: { continueAfterSetupFailure: boolean; mainCommandsSkippedOnSetupFailure: boolean };
      setupCommands: Array<{ status: string }>;
      commands: Array<{ status: string }>;
    };
    expect(run.status).toBe("setup_failed_main_passed");
    expect(run.setupPolicy).toMatchObject({ continueAfterSetupFailure: true, mainCommandsSkippedOnSetupFailure: false });
    expect(run.setupCommands[0]).toMatchObject({ status: "failed" });
    expect(run.commands[0]).toMatchObject({ status: "passed" });
    expect(await readFile(join(packetDir, "logs/command-001.stdout.log"), "utf8")).toContain("diagnostic main ran");
    const events = await readEvents(packetDir);
    expect(events.some((event) => event.type === "setup_diagnostic_main_commands_started")).toBe(true);
    expect(events.some((event) => event.type === "setup_skipped_main_commands")).toBe(false);
    const summary = await readFile(join(packetDir, "summary.md"), "utf8");
    expect(summary).toContain("Diagnostic mode: main commands ran despite setup failure.");
    expect(summary).toContain("do not treat this as a clean verification environment");
  });

  it("records setup timeout separately from main command timeouts", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-check-setup-timeout-"));

    await runCli([
      "external", "check",
      "--repo", repo,
      "--setup-command", "node -e \"setTimeout(() => {}, 2000)\"",
      "--command", "node -e \"console.log('should not run')\"",
      "--timeout-ms", "100",
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const run = JSON.parse(await readFile(join(packetDir, "run.json"), "utf8")) as {
      status: string;
      setupCommands: Array<{ status: string; timedOut: boolean }>;
      commands: Array<unknown>;
    };
    expect(run.status).toBe("setup_timed_out");
    expect(run.setupCommands[0]).toMatchObject({ status: "timed_out", timedOut: true });
    expect(run.commands).toHaveLength(0);
    const metrics = JSON.parse(await readFile(join(packetDir, "metrics.json"), "utf8")) as {
      setupCommandsTimedOut: number;
      commandsTimedOut: number;
    };
    expect(metrics.setupCommandsTimedOut).toBe(1);
    expect(metrics.commandsTimedOut).toBe(0);
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

  it("triages setup failure from setup logs and keeps readiness/code proposal gated", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-setup-chain-"));

    await runCli([
      "external", "proposal-readiness",
      "--repo", repo,
      "--setup-command", "node -e \"console.error('Local package.json exists, but node_modules missing.'); process.exit(1)\"",
      "--command", "node -e \"console.log('main should not run')\"",
      "--out", outDir
    ]);

    const readinessPacket = join(outDir, "packet");
    const readinessRun = JSON.parse(await readFile(join(readinessPacket, "run.json"), "utf8")) as {
      status: string;
      failureCategory: string;
      canAttemptCodeProposal: boolean;
    };
    expect(readinessRun).toMatchObject({
      status: "needs_more_context",
      failureCategory: "dependency_missing",
      canAttemptCodeProposal: false
    });
    expect(await readFile(join(readinessPacket, "recommended-next-action.md"), "utf8")).toContain("setup/preflight logs");

    const triagePacket = join(outDir, "triage-source", "packet");
    const rootCause = JSON.parse(await readFile(join(triagePacket, "root-cause.json"), "utf8")) as {
      sourceCheckStatus: string;
      category: string;
      readyForCodeProposal: boolean;
      commands: Array<{ phase: string; stderrPath: string }>;
    };
    expect(rootCause).toMatchObject({
      sourceCheckStatus: "setup_failed",
      category: "dependency_missing",
      readyForCodeProposal: false
    });
    expect(rootCause.commands[0]).toMatchObject({ phase: "setup", stderrPath: "logs/setup-001.stderr.log" });
    expect(await readFile(join(triagePacket, "evidence-excerpts.md"), "utf8")).toContain("node_modules missing");

    const codeOut = await mkdtemp(join(tmpdir(), "runforge-external-setup-code-"));
    await runCli([
      "external", "code-proposal",
      "--from-readiness-packet", readinessPacket,
      "--out", codeOut
    ]);
    const proposalStatus = JSON.parse(await readFile(join(codeOut, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
    };
    expect(proposalStatus.outcome).toBe("not_ready");
    expect(proposalStatus.patchBytes).toBe(0);
  });

  it("keeps diagnostic setup-failure runs gated even when main commands pass", async () => {
    const repo = await createGitFixtureRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-diagnostic-readiness-"));

    await runCli([
      "external", "proposal-readiness",
      "--repo", repo,
      "--setup-command", "node -e \"console.error('setup dependency missing'); process.exit(1)\"",
      "--continue-after-setup-failure",
      "--command", "node -e \"console.log('main diagnostic passed')\"",
      "--out", outDir
    ]);

    const readinessPacket = join(outDir, "packet");
    const readinessRun = JSON.parse(await readFile(join(readinessPacket, "run.json"), "utf8")) as {
      status: string;
      canAttemptCodeProposal: boolean;
    };
    expect(readinessRun).toMatchObject({
      status: "needs_more_context",
      canAttemptCodeProposal: false
    });
    expect(await readFile(join(readinessPacket, "recommended-next-action.md"), "utf8")).toContain("Fix setup/preflight first");

    const triagePacket = join(outDir, "triage-source", "packet");
    const rootCause = JSON.parse(await readFile(join(triagePacket, "root-cause.json"), "utf8")) as {
      sourceCheckStatus: string;
      readyForCodeProposal: boolean;
      setupPolicy: { continueAfterSetupFailure: boolean };
    };
    expect(rootCause).toMatchObject({
      sourceCheckStatus: "setup_failed_main_passed",
      readyForCodeProposal: false,
      setupPolicy: { continueAfterSetupFailure: true }
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
