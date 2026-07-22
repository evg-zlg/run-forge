import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";
import { discoverImplementationExecutors } from "../../src/implementation/executor.js";
import { executionPhaseOwner } from "../../src/product/execution-agreement.js";
import { startControlPlaneServer } from "../../src/control-plane/server.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../fixtures/implementation/simple-js");
const adapter = resolve(here, "../fixtures/implementation/coding-agent-adapter.mjs");
const previousCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND;
const runtimeEnvKeys = ["RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES", "RUNFORGE_EARLY_PROGRESS_DEADLINE_MS"] as const;
const previousRuntimeEnv = Object.fromEntries(runtimeEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  if (previousCommand === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; else process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = previousCommand;
  for (const key of runtimeEnvKeys) { const value = previousRuntimeEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe("implementation executor", () => {
  it("rejects a provider that cannot guarantee a mandatory cap before invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-cap-rejection-")); const marker = join(root, "invoked");
    const agent = await makeAgent(root, [`import { writeFileSync } from "node:fs";`, `writeFileSync(${JSON.stringify(marker)}, "called");`]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = JSON.stringify({ guarantees: { inputTokens: true, outputTokens: false, reasoningTokens: true, wallClock: true, calls: true } });
    await expect(execute(await repository(), "EXECUTOR-CAP-REJECT-1", "fix", ["node -e \"process.exit(0)\""])).rejects.toThrow(/mandatory.*output/i);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the effective envelope and truncates provider context", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-context-envelope-"));
    const agent = await makeAgent(root, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", "\\n// bounded candidate\\n");`,
      `console.log(JSON.stringify({ type: "candidate_diff", message: JSON.stringify({ envelope: JSON.parse(process.env.RUNFORGE_EXECUTION_ENVELOPE), prompt: process.env.RUNFORGE_IMPLEMENTATION_PROMPT }) }));`,
      `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5, reasoning_tokens: 2, cost_usd: 0.01 } }));`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = JSON.stringify({ maxInputContextTokens: 80 });
    const result = await execute(await repository(), "EXECUTOR-CONTEXT-1", `bounded task ${"oversized-context ".repeat(400)}`, ["node -e \"process.exit(0)\""], [], (value) => { value.discovery = { profile: "small-scope", maxFiles: 3, maxBytes: 300000, maxTokens: 6000, explicitFiles: ["calculator.js"], stopCondition: "stop" }; value.execution.maxCallsPerPhase = 4; });
    const call = result.providerCalls[0]; const summary = JSON.parse(call.stdout.split("\n").find((line: string) => line.includes("candidate_diff"))).message;
    const published = JSON.parse(summary);
    expect(published.envelope).toMatchObject({ profile: "small-scope", limits: { maxInputContextTokens: 80, maxCallsPerPhase: 4 }, phase: "implementation", taskId: "EXECUTOR-CONTEXT-1" });
    expect(published.prompt.length).toBeLessThanOrEqual(320);
    expect(call).toMatchObject({ executionEnvelope: { model: null, limits: { maxInputContextTokens: 80 } } });
  });

  it("fast-fails no-progress once without a hidden same-profile retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-no-progress-")); const agent = await makeAgent(root, [
      `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I am investigating and will edit the implementation soon" } }));`,
      `setInterval(() => {}, 1000);`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS = "30";
    const result = await execute(await repository(), "EXECUTOR-NO-PROGRESS-1", "fix", ["node -e \"process.exit(0)\""]);
    expect(result.providerCalls).toHaveLength(1);
    expect(result.providerCalls[0]).toMatchObject({ failureReason: expect.stringContaining("no_progress"), noProgress: true });
    expect(JSON.stringify(result.implementation)).toContain("no_progress");
    expect(result.diagnostics.retryPlan).toMatchObject({ automatic: false, sameModelProfileAllowed: false, options: expect.arrayContaining([expect.stringContaining("smaller context"), expect.stringContaining("faster model")]) });
  });

  it("treats a streamed RED test as progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-red-progress-")); const agent = await makeAgent(root, [
      `import { appendFileSync } from "node:fs";`,
      `console.log(JSON.stringify({ type: "test", status: "red", file: "calculator.test.js", line: 4, message: "RED test proves add is broken" }));`,
      `setTimeout(() => { appendFileSync("calculator.js", "\\n// candidate after RED\\n"); console.log(JSON.stringify({ type: "turn.completed", usage: { total_tokens: 10 } })); }, 60);`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`; process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS = "500";
    const result = await execute(await repository(), "EXECUTOR-RED-PROGRESS-1", "fix", ["node -e \"process.exit(0)\""]);
    expect(result.providerCalls[0]).toMatchObject({ noProgress: false, progressSignals: expect.objectContaining({ redTest: expect.any(String) }) });
  });

  it("treats a nested Codex file_change as progress and streams a checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-nested-file-change-")); const agent = await makeAgent(root, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", "\\n// nested Codex file change\\n");`,
      `console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: "calculator.js", kind: "update" }], status: "completed" } }));`,
      `setTimeout(() => console.log(JSON.stringify({ type: "turn.completed", usage: { total_tokens: 10 } })), 80);`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`; process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS = "30";
    const result = await execute(await repository(), "EXECUTOR-NESTED-FILE-CHANGE-1", "fix", ["node -e \"process.exit(0)\""]);
    expect(result.providerCalls[0]).toMatchObject({ noProgress: false, progressSignals: expect.objectContaining({ filesChanged: ["calculator.js"], candidateDiff: "calculator.js" }) });
    expect(result.artifact.checkpoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining("stream") })]));
  });

  it("treats nested Codex RED command output as progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-nested-red-command-")); const agent = await makeAgent(root, [
      `import { appendFileSync } from "node:fs";`,
      `console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "corepack pnpm vitest run tests/calculator.test.ts", aggregated_output: "FAIL tests/calculator.test.ts\\nexpected 3, received 2", exit_code: 1, status: "failed" } }));`,
      `setTimeout(() => { appendFileSync("calculator.js", "\\n// candidate after nested RED\\n"); console.log(JSON.stringify({ type: "turn.completed", usage: { total_tokens: 10 } })); }, 80);`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`; process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS = "30";
    const result = await execute(await repository(), "EXECUTOR-NESTED-RED-COMMAND-1", "fix", ["node -e \"process.exit(0)\""]);
    expect(result.providerCalls[0]).toMatchObject({ noProgress: false, progressSignals: expect.objectContaining({ redTest: expect.stringContaining("FAIL tests/calculator.test.ts"), tests: expect.arrayContaining([expect.stringContaining("vitest")]) }) });
  });

  it("preserves a streamed partial patch through provider timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-partial-timeout-")); const agent = await makeAgent(root, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", "\\n// durable partial patch\\n");`,
      `console.log(JSON.stringify({ type: "partial_patch", file: "calculator.js", message: "partial patch ready" }));`,
      `setInterval(() => {}, 1000);`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`; process.env.RUNFORGE_EARLY_PROGRESS_DEADLINE_MS = "500"; process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = JSON.stringify({ maxWallClockMs: 200 });
    const result = await execute(await repository(), "EXECUTOR-PARTIAL-TIMEOUT-1", "fix", ["node -e \"process.exit(0)\""]);
    expect(result.providerCalls).toHaveLength(1); expect(result.providerCalls[0]).toMatchObject({ timedOut: true });
    expect(result.artifact.checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result.implementation)).toContain("checkpoint_available");
    expect(JSON.stringify(result.implementation)).toContain("durable partial patch");
  });

  it("stops after reported usage exhausts the phase budget before another call", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-post-response-budget-")); const counter = join(root, "calls");
    const agent = await makeAgent(root, [
      `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";`,
      `const path = ${JSON.stringify(counter)}; const calls = existsSync(path) ? Number(readFileSync(path, "utf8")) + 1 : 1; writeFileSync(path, String(calls));`,
      `appendFileSync("calculator.js", "\\n// invalid candidate " + calls + "\\n");`,
      `console.log(JSON.stringify({ type: "candidate_diff", message: "candidate", usage: { input_tokens: 70, output_tokens: 50 } }));`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    const result = await execute(await repository(), "EXECUTOR-POST-BUDGET-1", "fix", ["node -e \"process.exit(1)\""], [], (value) => { value.execution.phaseBudgets = { implementation: 100, repair: 100 }; });
    expect(await readFile(counter, "utf8")).toBe("1"); expect(result.providerCalls).toHaveLength(1);
    expect(result.implementation).toMatchObject({ status: "blocked_with_owner_gate" });
  });
  it("preserves approved preset ownership through the shared resolver", () => {
    expect(executionPhaseOwner("assist-only", "localBranch")).toBe("external_session");
    expect(executionPhaseOwner("assist-only", "localCommit")).toBe("external_session");
    expect(executionPhaseOwner("local-ready", "localBranch")).toBe("runforge");
    expect(executionPhaseOwner("local-ready", "localCommit")).toBe("runforge");
  });

  it("discovers a real configured backend and rejects an unavailable backend", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    expect(await discoverImplementationExecutors()).toMatchObject([{ id: "local-coding-agent", status: "ready", supports: ["implementation", "repair"], providerCalls: true }]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
    expect(await discoverImplementationExecutors()).toMatchObject([{ status: "unavailable" }]);
  });

  it("implements, repairs, validates, adds a test, commits locally, and preserves the source checkout", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const beforeStatus = await git(repo, ["status", "--porcelain"]);
    const remote = await mkdtemp(join(tmpdir(), "runforge-implementation-remote-"));
    await git(remote, ["init", "--bare"]); await git(repo, ["remote", "add", "origin", remote]); await git(repo, ["push", "origin", "main"]);
    const remoteBefore = await git(repo, ["ls-remote", "origin"]);
    const result = await execute(repo, "EXECUTOR-SUCCESS-1", "REPAIR_LOOP ADD_TEST fix add", ["node test.js", "node added.test.js", "node lint.js", "node typecheck.js"]);
    expect(result.implementation).toMatchObject({ status: "implemented_and_validated", performed: true, changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), localBranch: "runforge/executor-success-1/standalone-attempt-1", localCommit: expect.any(String), patchPackage: expect.any(String) });
    expect(result.validation).toHaveLength(4);
    expect((result.validation as Array<Record<string, unknown>>).every((item) => item.exitCode === 0 && typeof item.stdout === "string" && typeof item.stderr === "string")).toBe(true);
    expect(result.providerCalls).toMatchObject([{ providerCalls: true, networkAuthorized: true }, { providerCalls: true, networkAuthorized: true }]);
    expect(result.providerCalls).toMatchObject([{ tokenUsage: 100 }, { tokenUsage: 100 }]);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      agreement: { profile: "local-ready", requestedProfile: "local-ready", effectiveProfile: "local-ready", runforgeCompletedPhases: expect.arrayContaining(["implementation", "localValidation", "patchPackage", "localBranch", "localCommit"]), awaitingPhases: expect.arrayContaining([{ phaseId: "remotePush", responsibleParty: "external_session", prerequisites: [] }]) },
      handoff: { profile: "local-ready", changedFiles: expect.arrayContaining(["calculator.js", "added.test.js"]), patch: "implementation.patch", branch: "runforge/executor-success-1/standalone-attempt-1", commit: expect.any(String), findings: [] },
      next: { party: "external_session", exactAction: expect.stringContaining("remotePush") },
      implementation: { unresolvedAcceptanceCriteria: [] },
      git: { branch: "runforge/executor-success-1/standalone-attempt-1", commit: expect.any(String) },
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before); expect(await git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
    expect((await git(repo, ["rev-parse", "refs/heads/main"])).trim()).toBe(before.trim());
    expect((await git(repo, ["rev-parse", "refs/heads/runforge/executor-success-1/standalone-attempt-1"])).trim()).toBe(result.git.commit);
    expect(await git(repo, ["ls-remote", "origin"])).toBe(remoteBefore);
    expect(await readFile(String((result.implementation as Record<string, unknown>).patchPackage), "utf8")).toContain("added.test.js");
    expect(result.publication).toMatchObject({ status: "on_hold", performed: false });
  }, 20_000);

  it("excludes RunForge dependency preparation artifacts from patches, checkpoints, and commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-dependency-filter-"));
    const agent = await makeAgent(root, [
      `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", "\\n// bounded candidate\\n");`,
      `mkdirSync(".pnpm-store/v11", { recursive: true }); writeFileSync(".pnpm-store/v11/index.db", "generated");`,
      `mkdirSync("node_modules/pkg", { recursive: true }); writeFileSync("node_modules/pkg/index.js", "generated");`,
      `mkdirSync("packages/pkg/node_modules/nested", { recursive: true }); writeFileSync("packages/pkg/node_modules/nested/index.js", "generated");`,
      `console.log(JSON.stringify({ type: "candidate_diff", message: "candidate ready" }));`,
    ]);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    const repo = await repository();
    const result = await execute(repo, "EXECUTOR-DEPENDENCY-FILTER-1", "fix add", ["node -e \"process.exit(0)\""]);
    const patch = await readFile(String(result.implementation.patchPackage), "utf8");
    expect(result.implementation).toMatchObject({ status: "implemented_and_validated", changedFiles: ["calculator.js"] });
    expect(result.handoff.changedFiles).toEqual(["calculator.js"]);
    expect(result.artifact.checkpoints.every((checkpoint: Record<string, any>) => !JSON.stringify(checkpoint).match(/(?:\.pnpm-store|node_modules)/))).toBe(true);
    for (const checkpoint of result.artifact.checkpoints as Array<Record<string, any>>) {
      const checkpointPatch = await readFile(join(dirname(String(result.implementation.patchPackage)), checkpoint.patchPath), "utf8");
      expect(checkpointPatch).not.toMatch(/(?:\.pnpm-store|node_modules)/);
    }
    expect(patch).toContain("calculator.js");
    expect(patch).not.toMatch(/(?:\.pnpm-store|node_modules)/);
    expect(await git(repo, ["show", "--format=", "--name-only", String(result.git.commit)])).toBe("calculator.js\n");
  });

  it("returns an assist-only patch without creating an externally owned branch or commit", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const refsBefore = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { execution, result } = await executeWithExecution(
      repo, "EXECUTOR-ASSIST-ONLY-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "assist-only" },
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      implementation: { status: "implemented_and_validated", localBranch: null, localCommit: null, patchPackage: expect.any(String) },
      git: { branch: null, commit: null, patchPackage: expect.any(String) },
      agreement: { profile: "assist-only", requestedProfile: "assist-only", effectiveProfile: "assist-only" },
      handoff: { profile: "assist-only", patch: "implementation.patch", branch: null, commit: null },
      next: { party: "external_session" },
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
    expect(await readFile(String(result.implementation.patchPackage), "utf8")).toContain("diff --git");
  });

  it.each([["external_session", "implementation"], ["external_system", "repair"]] as const)("hands %s-owned implementation off in %s mode without invoking the configured coding adapter", async (party, mode) => {
    const repo = await repository();
    const probeRoot = await mkdtemp(join(tmpdir(), "runforge-delegated-adapter-probe-"));
    const marker = join(probeRoot, "invoked");
    const probe = join(probeRoot, "adapter.mjs");
    await writeFile(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "invoked"); throw new Error("delegated adapter must not run");\n`);
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${probe}`;
    const before = {
      head: await git(repo, ["rev-parse", "HEAD"]),
      status: await git(repo, ["status", "--porcelain=v1", "-uall"]),
      refs: await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    };
    const { execution, result } = await executeWithExecution(
      repo, `EXECUTOR-DELEGATED-${party === "external_session" ? "SESSION" : "SYSTEM"}-1`, "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: party, localBranch: party, localCommit: party, providerModelCalls: party } },
      undefined, mode,
    );
    expect(execution).toMatchObject({ kind: "implementation", success: true, result: { status: "delegated", responsibleParty: party, selectedExecutor: { id: "agreement-handoff" }, providerCalls: [], publicationMutations: 0 } });
    expect(result).toMatchObject({
      status: party === "external_session" ? "awaiting_external_session" : "runforge_scope_completed",
      actualExecutorMode: "agreement-handoff",
      selectedExecutor: { id: "agreement-handoff", model: null },
      implementation: { status: "delegated", performed: false, responsibleParty: party, changedFiles: [], localBranch: null, localCommit: null },
      targetRepository: { initialSha: before.head.trim(), finalSha: before.head.trim(), changed: false, refsChanged: false },
      providerCalls: [], providerMutations: 0, publicationMutations: 0,
      publication: { performed: false, mutations: 0 },
      agreement: { profile: "custom", requestedProfile: "custom", effectiveProfile: "custom" },
      handoff: { profile: "assist-only", branch: null, commit: null },
      next: { party, exactAction: `Complete the delegated implementation phase in ${party} and attach its completion evidence.` },
      safetyAssertions: { targetUnchanged: true, providerCalls: false },
    });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await git(repo, ["status", "--porcelain=v1", "-uall"])).toBe(before.status);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.refs);
  });

  it("isolates deterministic RunForge branches across retry attempts and refuses only an exact attempt collision", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const statusBefore = await git(repo, ["status", "--porcelain"]);
    const first = await executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-a", "implementation", 1);
    const retry = await executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-b", "implementation", 2);
    expect(first.result.git.branch).toBe("runforge/executor-retry-branch-1/generation-a-attempt-1");
    expect(retry.result.git.branch).toBe("runforge/executor-retry-branch-1/generation-b-attempt-2");
    expect(retry.result.git.branch).not.toBe(first.result.git.branch);
    await expect(executeWithExecution(repo, "EXECUTOR-RETRY-BRANCH-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, "generation-b", "implementation", 2)).rejects.toThrow("local_branch_collision");
    expect((await git(repo, ["rev-parse", `refs/heads/${first.result.git.branch}`])).trim()).toBe(first.result.git.commit);
    expect((await git(repo, ["rev-parse", `refs/heads/${retry.result.git.branch}`])).trim()).toBe(retry.result.git.commit);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
  });

  it("creates a detached local commit without creating a RunForge-owned branch when only localCommit is owned", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const statusBefore = await git(repo, ["status", "--porcelain"]); const refsBefore = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { execution, result } = await executeWithExecution(repo, "EXECUTOR-COMMIT-ONLY-1", "fix add", ["node test.js"], [], {
      schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", patchPackage: "runforge", localBranch: "external_session", localCommit: "runforge" },
    }, "commit-only-generation", "implementation", 1);
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      implementation: { localBranch: null, localCommit: expect.any(String) },
      git: { branch: null, commit: expect.any(String) },
      workflow: {
        status: "awaiting_external_session",
        handoff: { profile: "assist-only", branch: null, commit: expect.any(String) },
        agreement: { runforgeCompletedPhases: expect.arrayContaining(["localCommit"]), awaitingPhases: expect.arrayContaining([{ phaseId: "localBranch", responsibleParty: "external_session", prerequisites: [] }]) },
      },
    });
    expect(await git(repo, ["cat-file", "-t", result.git.commit])).toBe("commit\n");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
  });

  it.each([
    ["external_session", "awaiting_external_session"],
    ["external_system", "runforge_scope_completed"],
  ] as const)("settles successfully while an %s implementation workflow phase remains delegated", async (party, completionStatus) => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const { execution, result } = await executeWithExecution(
      await repository(), "EXECUTOR-EXTERNAL-HANDOFF-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", independentReview: party } },
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: completionStatus,
      agreement: {
        runforgeCompletedPhases: ["implementation", "localValidation"],
        awaitingPhases: [{ phaseId: "independentReview", responsibleParty: party, prerequisites: [] }],
      },
      handoff: { profile: "assist-only", findings: [], nextActions: [{ party, exactAction: expect.stringContaining("independentReview") }] },
      next: { party, exactAction: expect.stringContaining("independentReview") },
    });
  });

  it("keeps control-plane settlement successful while preserving agreement-aware workflow semantics", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const { execution, result } = await executeWithExecution(
      await repository(), "EXECUTOR-CONTROL-SETTLEMENT-1", "fix add", ["node test.js"], [],
      { schemaVersion: 1, profile: "custom", phaseOwnership: { implementation: "runforge", localValidation: "runforge", independentReview: "external_session" } },
      "control-plane-execution",
    );
    expect(execution.success).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      workflow: {
        status: "awaiting_external_session",
        agreement: { awaitingPhases: [{ phaseId: "independentReview", responsibleParty: "external_session", prerequisites: [] }] },
        handoff: { profile: "assist-only", findings: [], nextActions: [{ party: "external_session" }] },
      },
    });
  });

  it.each([
    ["FALSE_POSITIVE", "no_change_required", "awaiting_external_session"],
    ["AMBIGUOUS_CHANGE", "blocked_with_owner_gate", "awaiting_owner"],
    ["FORBIDDEN_CHANGE", "blocked_with_owner_gate", "awaiting_owner"]
  ])("returns explicit outcome for %s", async (task, outcome, status) => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(), `EXECUTOR-${task}-1`, task, ["node test.js"], task === "FORBIDDEN_CHANGE" ? ["secrets.txt"] : []);
    expect(result.status).toBe(status); expect(result.implementation).toMatchObject({ status: outcome });
  });

  it("ignores credential-like assignments that appear only as unchanged patch context", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(true), "EXECUTOR-SECRET-CONTEXT-1", "fix add", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_external_session",
      implementation: { status: "implemented_and_validated", localCommit: expect.any(String) },
      safetyAssertions: { secretScanPassed: true },
    });
  });

  it("snapshots from the accepted SHA while distinguishing user dirt from known RunForge telemetry", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const snapshotRepo = await repository(); await writeFile(join(snapshotRepo, "human-notes.txt"), "preserve me\n"); const before = await git(snapshotRepo, ["status", "--porcelain=v1"]);
    const snapshot = await executeWithExecution(snapshotRepo, "EXECUTOR-DIRTY-SNAPSHOT-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" });
    expect(snapshot.result).toMatchObject({ implementation: { status: "implemented_and_validated" }, diagnostics: { dirtyPolicy: "use_disposable_from_base_sha" }, safetyAssertions: { sourceWorktreeStateUnchanged: true } }); expect(await git(snapshotRepo, ["status", "--porcelain=v1"])).toBe(before);
    const strictRepo = await repository(); await writeFile(join(strictRepo, "human-notes.txt"), "preserve me\n"); await expect(executeWithExecution(strictRepo, "EXECUTOR-DIRTY-STRICT-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, undefined, "implementation", undefined, "require_clean")).rejects.toThrow("active_human_work_conflict");
    const telemetryRepo = await repository(); await import("node:fs/promises").then(({ mkdir }) => mkdir(join(telemetryRepo, ".runforge"))); await writeFile(join(telemetryRepo, ".runforge", "trace.log"), "task-owned\n");
    await expect(executeWithExecution(telemetryRepo, "EXECUTOR-DIRTY-TELEMETRY-1", "fix add", ["node test.js"], [], { schemaVersion: 1, profile: "local-ready" }, undefined, "implementation", undefined, "allow_known_generated")).resolves.toMatchObject({ result: { implementation: { status: "implemented_and_validated" } } });
  });

  it("rejects a credential-like assignment newly added by the implementation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-secret-agent-")); const agent = join(root, "agent.mjs");
    await writeFile(agent, [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync("calculator.js", ["\\n// API", "_KEY=", "newlyaddedvalue", "\\n"].join(""));`,
      `console.log("implemented bounded change");`,
      `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } }));`,
    ].join("\n"));
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${agent}`;
    const result = await execute(await repository(), "EXECUTOR-SECRET-ADDITION-1", "add rejected fixture line", ["node test.js"]);
    expect(result).toMatchObject({
      status: "awaiting_owner",
      implementation: { status: "blocked_with_owner_gate", localCommit: null },
      safetyAssertions: { secretScanPassed: false },
    });
  });

  it("marks empty non-zero validation output as an infrastructure defect", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const result = await execute(await repository(), "EXECUTOR-EMPTY-DIAGNOSTIC-1", "fix add", ["node -e \"process.exit(1)\""]);
    expect(result).toMatchObject({ status: "failed", implementation: { status: "failed_with_diagnostics" } });
    expect(result.validation).toMatchObject([{ exitCode: 1, stdout: "", stderr: "", infrastructureDefect: "non-zero exit produced empty stdout and stderr" }]);
  });

  it("runs end-to-end through localhost HTTP with visible selection and publication separation", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-control-"));
    const sourceHeadBefore = await git(repo, ["rev-parse", "HEAD"]); const sourceStatusBefore = await git(repo, ["status", "--porcelain"]);
    const remote = await mkdtemp(join(tmpdir(), "runforge-implementation-http-remote-"));
    await git(remote, ["init", "--bare"]); await git(repo, ["remote", "add", "origin", remote]); await git(repo, ["push", "origin", "main"]);
    const remoteBefore = await git(repo, ["ls-remote", "origin"]);
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      expect(capabilities.implementationExecutors).toMatchObject([{ status: "ready" }]);
      expect(capabilities.implementationExecutors[0].command).toBeUndefined();
      expect(capabilities.taskSpecContract).toMatchObject({ contractVersion: "task-spec-v2", schemaVersion: 2, schemaUrl: "/schemas/task-spec-v2.schema.json", schema: { required: expect.arrayContaining(["execution"]) }, runtimeDefaults: { implementation: "local-disposable" }, implementationRequest: { taskSpec: { execution: { mode: "implementation", maxProviderTokens: 200000 }, runtime: { preference: "local-disposable" } }, authority: { localBranch: true, localCommit: true } } });
      expect(capabilities.taskSpecContract.implementationRequest.taskSpec.execution.maxProviderTokens).toBe(capabilities.implementationExecutors[0].maxLimits.providerTokens);
      const discovery = await fetch(`${server.url}/.well-known/runforge`).then((response) => response.json()) as Record<string, any>;
      expect(discovery.taskSpecContract).toMatchObject({ implementationExecutorIds: ["local-coding-agent"], compatibleRuntimes: { "local-coding-agent": ["local-disposable"] }, implementationRequest: { taskSpec: { runtime: { preference: "local-disposable" } } } });
      const schemaResponse = await fetch(`${server.url}${discovery.endpoints.taskSpecSchema}`); expect(schemaResponse.status).toBe(200);
      const schema = await schemaResponse.json() as Record<string, any>; expect(schema).toMatchObject({ title: "RunForge TaskSpec v2", required: expect.arrayContaining(["execution"]), properties: { runtime: { properties: { preference: { enum: ["docker", "local-disposable"] } } } } });
      expect(schema).toEqual(JSON.parse(await readFile(resolve(here, "../../schemas/task-spec-v2.schema.json"), "utf8")));
      const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(schema); expect(validate(discovery.taskSpecContract.implementationRequest.taskSpec), validate.errors?.map((item: { instancePath: string; message?: string }) => `${item.instancePath} ${item.message}`).join("; ")).toBe(true);
      const ready = await fetch(`${server.url}/readyz`).then((response) => response.json()) as Record<string, any>;
      expect(ready.implementationExecutors).toMatchObject(discovery.implementationExecutors.map((item: Record<string, unknown>) => ({ id: item.id, status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime, maxLimits: item.maxLimits, model: item.model, credentialReady: item.credentialReady })));
      expect(discovery.implementationExecutors).toEqual(capabilities.implementationExecutors);
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true, runtime: "local" }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(discovery.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-HTTP-1"; request.taskSpec.task.text = "ADD_TEST fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js", "node added.test.js"] };
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(created.status).toBe(202);
      const accepted = await created.json() as Record<string, any>; expect(accepted.selection).toMatchObject({ requestedMode: "implementation", normalizedMode: "implementation", selectedExecutor: "local-coding-agent", selectedRuntime: "local-disposable", authorityChecks: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true }, providerDecision: "allowed", networkDecision: "allowed" });
      const terminal = await poll(`${server.url}/v1/tasks/EXECUTOR-HTTP-1`); expect(terminal.status).toBe("completed");
      expect(terminal.events.map((item: any) => item.detail).join(" ")).toContain("implement:");
      const result = await fetch(`${server.url}/v1/tasks/EXECUTOR-HTTP-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(result).toMatchObject({
        status: "completed",
        workflow: {
          status: "awaiting_external_session",
          agreement: { profile: "local-ready", requestedProfile: "local-ready", effectiveProfile: "local-ready", runforgeCompletedPhases: expect.arrayContaining(["implementation", "localValidation", "patchPackage", "localBranch", "localCommit"]) },
          handoff: { profile: "local-ready", findings: [], branch: expect.stringMatching(/^runforge\/executor-http-1\/[a-z0-9-]+-attempt-1$/), commit: expect.any(String) },
          next: { party: "external_session", exactAction: expect.stringContaining("remotePush") },
        },
        requestedIntent: "implementation", actualExecutorMode: "implementation",
        implementation: { status: "implemented_and_validated", unresolvedAcceptanceCriteria: [] },
        publication: { status: "on_hold", performed: false },
      });
      expect(result.workflow.agreement.awaitingPhases).toEqual(expect.arrayContaining([
        expect.objectContaining({ phaseId: "remotePush", responsibleParty: "external_session" }),
      ]));
      expect(result).toMatchObject({
        implementation: { localBranch: result.workflow.handoff.branch, localCommit: expect.any(String) },
        git: { branch: result.workflow.handoff.branch, commit: expect.any(String) },
      });
      const persisted = JSON.parse(await readFile(join(state, "tasks", "EXECUTOR-HTTP-1", "result.json"), "utf8")) as Record<string, any>;
      expect(persisted.result.workflow.handoff.branch).toBe(result.workflow.handoff.branch);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
      expect(await git(repo, ["status", "--porcelain"])).toBe(sourceStatusBefore);
      expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
      expect(await git(repo, ["ls-remote", "origin"])).toBe(remoteBefore);
    } finally { await server.close(); }
  }, 20_000);

  it("preserves a green implementation across post-implementation overrun and accepts it idempotently without provider rerun", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const before = await git(repo, ["rev-parse", "HEAD"]); const state = await mkdtemp(join(tmpdir(), "runforge-durable-overrun-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const capabilities = await fetch(`${server.url}/v1/capabilities`).then((response) => response.json()) as Record<string, any>;
      const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, register: true }) }).then((response) => response.json()) as Record<string, any>;
      const request = structuredClone(capabilities.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "EXECUTOR-DURABLE-OVERRUN-1"; request.taskSpec.task.text = "BUDGET_OVERRUN fix add"; request.taskSpec.validation = { mode: "explicit", commands: ["node test.js"] }; request.taskSpec.execution.phaseBudgets.implementation = 1_000;
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }); expect(created.status).toBe(202);
      const acceptedTask = await created.json() as Record<string, any>; expect(acceptedTask.timeout).toMatchObject({ requestedMs: 300000, effectiveMs: 300000, limitingSource: "requested" });
      const terminal = await poll(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1`); expect(terminal.status).toBe("awaiting_owner_decision");
      const result = await fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/result`).then((response) => response.json()) as Record<string, any>;
      expect(result).toMatchObject({ implementation: { status: "implemented_and_validated" }, artifact: { status: "available", bestValidatedCheckpointId: "implementation-0" }, workflow: { status: "awaiting_owner", budgetExceeded: true }, usage: { accounting: "provider", totalTokens: 120000, costUsd: null, syntheticAccounting: { mixedWithProviderUsage: false } }, ownerGate: { required: true, options: expect.arrayContaining([expect.objectContaining({ id: "accept_completed_patch", providerRun: false })]) }, handoffPackage: { status: "available", bestValidatedCheckpoint: "implementation-0" } });
      expect(await readFile(join(state, "tasks", "EXECUTOR-DURABLE-OVERRUN-1", "attempts", "1", "artifacts", result.artifact.checkpoints[0].patchPath), "utf8")).toContain("diff --git");
      const implicitDiscard = await fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/discard-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkpointId: "implementation-0" }) }); expect(implicitDiscard.status).toBe(400);
      const body = JSON.stringify({ decisionId: "accept-overrun-1", checkpointId: "implementation-0", delivery: "patch" });
      const [first, replay] = await Promise.all([fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/accept-completed-result`, { method: "POST", headers: { "content-type": "application/json" }, body }), fetch(`${server.url}/v1/tasks/EXECUTOR-DURABLE-OVERRUN-1/accept-completed-result`, { method: "POST", headers: { "content-type": "application/json" }, body })]);
      expect(first.status).toBe(200); expect(replay.status).toBe(200); const responses = [await first.json(), await replay.json()] as Record<string, any>[]; expect(responses).toEqual(expect.arrayContaining([expect.objectContaining({ status: "accepted", patch: expect.stringContaining("diff --git"), providerCalls: 0, providerRerun: false, targetMainMutation: false }), expect.objectContaining({ idempotentReplay: true, providerCalls: 0 })]));
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    } finally { await server.close(); }
  }, 20_000);

  it("blocks provider denial and unavailable executors before accepting implementation work", async () => {
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-preflight-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
      const denied = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-DENIED-1", "fix", ["node test.js"]), authority: { implementation: true, localBranch: true, localCommit: true } }) });
      expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { code: "provider_authority_denied" } });
      process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = "/definitely/missing/runforge-agent";
      const unavailable = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-UNAVAILABLE-1", "fix", ["node test.js"]), authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ error: { code: "implementation_executor_unavailable" } });
      expect((await server.manager.store.listTasks()).map((item) => item.id)).not.toContain("EXECUTOR-UNAVAILABLE-1");
    } finally { await server.close(); }
  });

  it("returns specific preflight errors without creating downgraded tasks", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-contract-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    const fullAuthority = { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true };
    const cases: Array<[string, (value: Record<string, any>) => void, Record<string, boolean>, string]> = [
      ["PROVIDER", (value) => { value.authority.allowProviderCalls = false; }, fullAuthority, "provider_permission_denied"],
      ["NETWORK", (value) => { value.authority.allowNetwork = false; value.runtime.externalNetwork = "denied"; }, fullAuthority, "network_permission_denied"],
      ["MUTATION", () => undefined, { ...fullAuthority, localBranch: false, localCommit: false }, "mutation_authority_denied"],
      ["COMMIT", () => undefined, { ...fullAuthority, localCommit: false }, "local_commit_authority_denied"],
      ["RUNTIME", (value) => { value.runtime.preference = "docker"; }, fullAuthority, "runtime_incompatible"]
    ];
    try {
      for (const [name, mutate, authority, code] of cases) {
        const value = spec(repo, `EXECUTOR-${name}-PREFLIGHT`, "fix", ["node test.js"]); mutate(value);
        const response = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: value, authority }) });
        expect(response.status).toBeGreaterThanOrEqual(400); const error = await response.json(); expect(error).toMatchObject({ error: { code, details: { operation: "start_new_task", newTaskRequired: true } } });
        if (name === "RUNTIME") expect(error).toMatchObject({ error: { code: "runtime_incompatible", message: expect.stringContaining("local-disposable"), details: { executorId: "local-coding-agent", requestedRuntime: "docker", allowedValues: ["docker", "local-disposable"], compatibleRuntimes: ["local-disposable"], correctedRequest: { taskSpec: { runtime: { preference: "local-disposable" } } } } } });
      }
      expect(await server.manager.store.listTasks()).toHaveLength(0);
    } finally { await server.close(); }
  });

  it("uses the documented compatible runtime when implementation runtime is omitted", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-default-runtime-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const value: Record<string, any> = spec(repo, "EXECUTOR-DEFAULT-RUNTIME-1", "fix", ["node test.js"]); delete value.runtime.preference;
      const response = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: value, authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ selection: { selectedExecutor: "local-coding-agent", selectedRuntime: "local-disposable" } });
    } finally { await server.close(); }
  });

  it("cancels a live coding process and revokes its execution lease", async () => {
    process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`;
    const repo = await repository(); const state = await mkdtemp(join(tmpdir(), "runforge-implementation-cancel-"));
    const server = await startControlPlaneServer({ port: 0, stateRoot: state });
    try {
      const created = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskSpec: spec(repo, "EXECUTOR-CANCEL-1", "CANCEL_FOREVER", ["node test.js"]), authority: { implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true } }) });
      expect(created.status).toBe(202); await pollPhase(`${server.url}/v1/tasks/EXECUTOR-CANCEL-1`, "implement");
      const cancelled = await fetch(`${server.url}/v1/tasks/EXECUTOR-CANCEL-1/cancel`, { method: "POST" }).then((response) => response.json()) as Record<string, any>;
      expect(cancelled).toMatchObject({ status: "interrupted", progress: { workerStatus: "cancelled" }, execution: { lease: { state: "revoked" } } });
    } finally { await server.close(); }
  }, 20_000);
});

async function repository(withSensitiveContext = false): Promise<string> { const repo = await mkdtemp(join(tmpdir(), "runforge-implementation-repo-")); await cp(fixture, repo, { recursive: true }); if (withSensitiveContext) { const path = join(repo, "calculator.js"); const source = await readFile(path, "utf8"); const context = ["// API", "_KEY=", "existingvalue", "\n"].join(""); await writeFile(path, context + source); } await git(repo, ["init", "-b", "main"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]); return repo; }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
function spec(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = []) { return { schemaVersion: 2, taskId, task: { text, goal: "Make the deterministic fixture satisfy acceptance", acceptanceCriteria: ["validation is green", "local patch evidence exists"] }, target: { repository: repo, workingDirectory: "." }, execution: { mode: "implementation", maxRepairIterations: 2 }, runtime: { preference: "local-disposable", externalNetwork: "allowed", dependencyPreparation: "disabled" }, validation: { mode: "explicit", commands }, authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: true, forbiddenAreas }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" } }; }
async function execute(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[] = [], configure?: (value: Record<string, any>) => void): Promise<Record<string, any>> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-artifacts-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); configure?.(value); value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); await runTaskSpecFile(specPath); return JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")); }
async function makeAgent(root: string, source: string[]): Promise<string> { const path = join(root, "agent.mjs"); await writeFile(path, source.join("\n") + "\n"); return path; }
async function executeWithExecution(repo: string, taskId: string, text: string, commands: string[], forbiddenAreas: string[], executionAgreement: Record<string, unknown>, executionId?: string, executionMode: "implementation" | "repair" = "implementation", attempt?: number, dirtyPolicy?: string): Promise<{ execution: Awaited<ReturnType<typeof runTaskSpecFile>>; result: Record<string, any> }> { const root = await mkdtemp(join(tmpdir(), "runforge-implementation-agreement-")); const specPath = join(root, "task.json"); const value: Record<string, any> = spec(repo, taskId, text, commands, forbiddenAreas); value.execution.mode = executionMode; value.executionAgreement = executionAgreement; if (dirtyPolicy) value.target.dirtyPolicy = dirtyPolicy; value.artifacts = { root: join(root, "artifacts"), resultFormat: "normalized-v1" }; await import("node:fs/promises").then(({ writeFile }) => writeFile(specPath, JSON.stringify(value))); const execution = await runTaskSpecFile(specPath, { executionId, attempt }); return { execution, result: JSON.parse(await readFile(join(root, "artifacts", "results.json"), "utf8")) }; }
async function poll(url: string): Promise<Record<string, any>> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("task did not finish"); }
async function pollPhase(url: string, phase: string): Promise<void> { for (let index = 0; index < 200; index += 1) { const task = await fetch(url).then((response) => response.json()) as Record<string, any>; if (task.progress?.phase === phase) return; await new Promise((done) => setTimeout(done, 25)); } throw new Error(`task did not reach ${phase}`); }
