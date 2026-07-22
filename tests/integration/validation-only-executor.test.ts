import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { negotiateExecutionAgreement, type ExecutionParty } from "../../src/product/execution-agreement.js";
import { runTaskSpecFile } from "../../src/product/task-spec-runner.js";
import { loadTaskSpecV2 } from "../../src/product/task-spec-v2.js";
import { materializeAutonomousGitSnapshot } from "../../src/run/task-run-workspace.js";
import { runValidationOnlyExecutor } from "../../src/validation/validation-only-executor.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => { vi.unstubAllGlobals(); delete process.env.OPENROUTER_API_KEY; process.env.PATH = originalPath; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("validation-only multi-lane execution", () => {
  it("performs only the explicitly owned provider review with bounded existing source and complete accounting", async () => {
    const fixture = await semanticReviewFixture(["node --version"]);
    const before = immutableSourceSnapshot(fixture.repository);
    process.env.OPENROUTER_API_KEY = "test-key";
    const finding = { severity: "medium", file: "src/review.ts", location: "1", category: "behavior", evidence: "value is stable", recommendation: "retain coverage", blocking: false };
    const fetchMock = vi.fn().mockResolvedValue(openRouterResponse(JSON.stringify({ semanticReview: { confidence: "high", limitations: ["bounded source"], findings: [finding] } }), "review-request", 17, 0.004));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runValidationOnlyExecutor({ spec: fixture.spec, executionAgreement: fixture.agreement });
    expect(result).toMatchObject({ status: "completed", source: { unchanged: true }, review: { semantic: { status: "completed", performed: true, reviewer: { provider: "openrouter", model: "review/model", invocationId: "review-request" }, findings: [finding] } }, usage: { providerCalls: 1, totalTokens: 17, costUsd: 0.004, phases: { reviewer: 1, logCompression: 0 } } });
    expect(result.providerCalls).toEqual([expect.objectContaining({ purpose: "semantic-review", phase: "reviewer", provider: "openrouter", model: "review/model", invocationId: "review-request", success: true, tokenUsage: 17, costUsd: 0.004 })]);
    expect(result.providerCalls.some((call) => ["planner", "implementer", "repair"].includes(String(call.phase)))).toBe(false);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.model).toBe("review/model");
    expect(body.messages[1].content).toContain("--- BEGIN FILE src/review.ts ---");
    expect(body.messages[1].content).toContain("export const reviewedValue = 1");
    expect(body.messages[1].content).toContain("Validation-only review inspects bounded existing source");
    expect(immutableSourceSnapshot(fixture.repository)).toEqual(before);
    expect(result.executionAgreement.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: "independentReview", status: "completed" }),
      expect.objectContaining({ phaseId: "providerModelCalls", status: "completed" }),
    ]));
  });

  it("honors standalone TaskSpec custom dual opt-in without an injected execution agreement", async () => {
    const fixture = await semanticReviewFixture(["node --version"]); process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(openRouterResponse(JSON.stringify({ semanticReview: { confidence: "high", limitations: [], findings: [] } }), "standalone-review", 9, 0.002)); vi.stubGlobal("fetch", fetchMock);
    const execution = await runTaskSpecFile(fixture.specPath);
    expect(execution).toMatchObject({ kind: "validation", success: true, result: { status: "completed", review: { semantic: { performed: true, reviewer: { invocationId: "standalone-review" } } }, providerCalls: [expect.objectContaining({ purpose: "semantic-review" })] } });
    const publicResult = JSON.parse(await readFile(join(fixture.artifacts, "results.json"), "utf8"));
    expect(publicResult).toMatchObject({ review: { semantic: { performed: true } }, agreement: { runforgeCompletedPhases: expect.arrayContaining(["independentReview", "providerModelCalls"]) }, safetyAssertions: { providerCalls: true } });
  });

  it("compresses failed optional output before review and never sends raw canaries to the reviewer", async () => {
    const fixture = await semanticReviewFixture(["node fail.cjs"], "optional");
    await writeFile(join(fixture.repository, "fail.cjs"), "process.stdout.write('RAW_STDOUT_CANARY'); process.stderr.write('RAW_STDERR_CANARY'); process.exit(1);\n");
    fixture.spec.providerRouting.retry.maxAttempts = 2;
    fixture.spec.providerRouting.tokenBudget.perPhase.logCompression = 2_000;
    process.env.OPENROUTER_API_KEY = "test-key";
    let compressionAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); const model = body.model as string; const prompt = body.messages[1].content as string;
      if (model === "compress/model") {
        compressionAttempts += 1;
        expect(body.max_tokens).toBeGreaterThan(0); expect(body.max_tokens).toBeLessThan(fixture.spec.providerRouting.tokenBudget.perPhase.logCompression);
        if (compressionAttempts === 1) return new Response(JSON.stringify({ error: "retry" }), { status: 429 });
        const raw = JSON.parse(prompt.split("\n\n").at(-1)!);
        return openRouterResponse(JSON.stringify({ schemaVersion: 1, kind: "log-digest", summary: "optional validation failed", failureClass: "test.failure", diagnostics: ["inspect local artifact"], sources: raw.sources.map(({ redactions: _redactions, ...source }: any) => source) }), "compress-request", 5, 0.001);
      }
      expect(prompt).not.toContain("RAW_STDOUT_CANARY"); expect(prompt).not.toContain("RAW_STDERR_CANARY");
      expect(prompt).toContain("optional validation failed");
      return openRouterResponse(JSON.stringify({ semanticReview: { confidence: "medium", limitations: ["optional command failed"], findings: [] } }), "review-request", 11, 0.003);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runValidationOnlyExecutor({ spec: fixture.spec, executionAgreement: fixture.agreement });
    expect(result.review.semantic.limitations).toEqual(["optional command failed"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "completed", validationAggregate: "completed_with_validation_gaps", usage: { providerCalls: 2, totalTokens: 16, costUsd: 0.004, phases: { reviewer: 1, logCompression: 1 } } });
    expect(result.providerCalls.map((call) => call.purpose)).toEqual(["raw-log-compression", "semantic-review"]);
    expect(result.providerCalls[0]).toMatchObject({ attempts: 2 });
  });

  it("fails closed when compression or the required reviewer is unavailable, while legacy validation makes no provider call", async () => {
    const rawFixture = await semanticReviewFixture(["node -e \"process.stderr.write('RAW_FAILURE'); process.exit(1)\""], "optional");
    process.env.OPENROUTER_API_KEY = "test-key";
    const failedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 500 })); vi.stubGlobal("fetch", failedFetch);
    const compressedFailure = await runValidationOnlyExecutor({ spec: rawFixture.spec, executionAgreement: rawFixture.agreement });
    expect(compressedFailure).toMatchObject({ status: "failed", review: { semantic: { status: "unavailable", performed: false } } });
    expect(failedFetch).toHaveBeenCalledTimes(1);
    expect(compressedFailure.providerCalls).toEqual([expect.objectContaining({ purpose: "raw-log-compression", success: false, exitCode: 1, attempts: 1, status: 500 })]);
    expect(await readFile(join(rawFixture.artifacts, "provider", "log-compression-failure-validation-0.json"), "utf8")).toContain('"success": false');
    expect(compressedFailure.executionAgreement.phases.find((phase) => phase.phaseId === "independentReview")?.status).not.toBe("completed");

    const legacy = await semanticReviewFixture(["node --version"], "required", false);
    const legacyFetch = vi.fn(); vi.stubGlobal("fetch", legacyFetch);
    const legacyResult = await runValidationOnlyExecutor({ spec: legacy.spec, executionAgreement: legacy.agreement });
    expect(legacyResult).toMatchObject({ status: "completed", providerCalls: [], usage: { providerCalls: 0 }, review: { semantic: { performed: false } } });
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("records a completed reviewer transport before malformed DTO parsing and parses full content beyond the artifact excerpt", async () => {
    const malformed = await semanticReviewFixture(["node --version"]); process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openRouterResponse("not-json", "malformed-review", 13, 0.002)));
    const failed = await runValidationOnlyExecutor({ spec: malformed.spec, executionAgreement: malformed.agreement });
    expect(failed).toMatchObject({ status: "failed", review: { semantic: { performed: false, status: "unavailable" } }, providerCalls: [expect.objectContaining({ purpose: "semantic-review", invocationId: "malformed-review", success: true, exitCode: 0, tokenUsage: 13, costUsd: 0.002 })] });
    expect(await readFile(join(malformed.artifacts, "provider", "semantic-review.json"), "utf8")).toContain("not-json");

    const bounded = await semanticReviewFixture(["node --version"]);
    const fullPayload = `${" ".repeat(17_000)}${JSON.stringify({ semanticReview: { confidence: "high", limitations: [], findings: [] } })}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openRouterResponse(fullPayload, "full-review", 15, 0.003)));
    const completed = await runValidationOnlyExecutor({ spec: bounded.spec, executionAgreement: bounded.agreement });
    expect(completed).toMatchObject({ status: "completed", review: { semantic: { performed: true, reviewer: { invocationId: "full-review" } } } });
    expect(await readFile(join(bounded.artifacts, "provider", "semantic-review.json"), "utf8")).toContain("[TRUNCATED]");
  });

  it("blocks log compression before fetch when token or hard-cost allowance is unavailable", async () => {
    const tokenFixture = await semanticReviewFixture(["node fail.cjs"], "optional"); await writeFile(join(tokenFixture.repository, "fail.cjs"), "process.stderr.write('failure'); process.exit(1);\n");
    tokenFixture.spec.providerRouting.tokenBudget.perPhase.logCompression = 1;
    process.env.OPENROUTER_API_KEY = "test-key"; const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const tokenResult = await runValidationOnlyExecutor({ spec: tokenFixture.spec, executionAgreement: tokenFixture.agreement });
    expect(tokenResult).toMatchObject({ status: "failed", providerCalls: [], review: { semantic: { limitations: [expect.stringContaining("raw_log_compression_required")] } } }); expect(fetchMock).not.toHaveBeenCalled();

    const costFixture = await semanticReviewFixture(["node fail.cjs"], "optional"); await writeFile(join(costFixture.repository, "fail.cjs"), "process.stderr.write('failure'); process.exit(1);\n"); costFixture.spec.providerRouting.costBudgetUsd = 1;
    const costResult = await runValidationOnlyExecutor({ spec: costFixture.spec, executionAgreement: costFixture.agreement });
    expect(costResult).toMatchObject({ status: "failed", providerCalls: [], review: { semantic: { limitations: [expect.stringContaining("raw_log_compression_required")] } } }); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects symlink escapes, secret files, noisy files, empty subjects, and local host-shell execution before review", async () => {
    const fixture = await semanticReviewFixture(["node --version"]);
    const outside = join(fixture.root, "outside.ts"); await writeFile(outside, "export const outside = true;\n");
    await symlink(outside, join(fixture.repository, "escape.ts"));
    await writeFile(join(fixture.repository, ".env"), `API_KEY=sk-${"x".repeat(30)}\n`);
    await writeFile(join(fixture.repository, "review.log"), "RAW_LOG_MUST_NOT_BE_REVIEWED\n");
    fixture.spec.discovery.explicitFiles = ["escape.ts", ".env", "review.log"];
    fixture.spec.discovery.maxFiles = 3;
    process.env.OPENROUTER_API_KEY = "test-key"; const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const result = await runValidationOnlyExecutor({ spec: fixture.spec, executionAgreement: fixture.agreement });
    expect(result).toMatchObject({ status: "failed", providerCalls: [], review: { semantic: { status: "unavailable", performed: false, limitations: [expect.stringContaining("semantic_review_subject_unavailable")] } } });
    expect(fetchMock).not.toHaveBeenCalled();
    fixture.spec.runtime.preference = "local-disposable";
    await expect(runValidationOnlyExecutor({ spec: fixture.spec, executionAgreement: fixture.agreement })).rejects.toThrow("requires Docker");
  });
  it("creates a clean autonomous Git snapshot at the exact source HEAD without touching the source", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-synthetic-validation-git-"))) - 1]!, source = join(root, "source"), workspace = join(root, "campaign-worktrees", "cmp_v1_fixture");
    await mkdir(source); await mkdir(join(workspace, "node_modules"), { recursive: true }); await mkdir(join(workspace, ".runforge-corepack")); await mkdir(join(workspace, ".runforge-tmp"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source }); execFileSync("git", ["config", "user.name", "Source"], { cwd: source }); execFileSync("git", ["config", "user.email", "source@example.invalid"], { cwd: source });
    await writeFile(join(source, "README.md"), "source\n"); await writeFile(join(source, ".gitignore"), "ignored-cache/\n"); execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: source }); execFileSync("git", ["commit", "-qm", "source"], { cwd: source });
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    await writeFile(join(workspace, "package.json"), "{}\n"); await writeFile(join(workspace, "node_modules", "dependency.js"), "module.exports = true;\n"); await writeFile(join(workspace, ".runforge-corepack", "cache"), "offline\n"); await mkdir(join(workspace, "ignored-cache")); await writeFile(join(workspace, "ignored-cache", "stale.bin"), "stale\n");
    await materializeAutonomousGitSnapshot(source, workspace, sourceHead);
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("true");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("runforge-validation-snapshot");
    expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("/dev/null");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim()).toBe(sourceHead);
    expect(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: workspace, encoding: "utf8" }).trim()).toBe(".git");
    await expect(access(join(workspace, ".git", "objects", "info", "alternates"))).rejects.toThrow();
    for (const stale of ["package.json", "node_modules", ".runforge-corepack", ".runforge-tmp", "ignored-cache"]) await expect(access(join(workspace, stale))).rejects.toThrow();
    expect(execFileSync("git", ["ls-files"], { cwd: workspace, encoding: "utf8" })).toContain("README.md");
    expect(execFileSync("git", ["ls-files"], { cwd: workspace, encoding: "utf8" })).not.toContain("node_modules");
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", join(workspace, "nested-worktree"), "HEAD"], { cwd: workspace });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(workspace, "nested-worktree"), encoding: "utf8" }).trim()).toBe(sourceHead);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()).toBe(sourceHead);
    expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: source, encoding: "utf8" }).trim()).toBe("");
  });

  it("executes package validation when if-needed can reuse source dependencies", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-validation-dependencies-"))) - 1]!;
    const repository = join(root, "source"); const artifacts = join(root, "artifacts"); const bin = join(root, "bin");
    await mkdir(join(repository, "packages", "app", "node_modules", ".bin"), { recursive: true }); await mkdir(bin);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
    await writeFile(join(repository, ".gitignore"), "node_modules/\n");
    await writeFile(join(repository, "packages", "app", "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "fixture-check" } }));
    await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const fixtureExecutable = join(repository, "packages", "app", "node_modules", ".bin", "fixture-check");
    await writeFile(fixtureExecutable, "#!/bin/sh\nprintf 'fixture dependency executable ran\\n'\n"); await chmod(fixtureExecutable, 0o755);
    execFileSync("git", ["add", ".gitignore", "packages/app/package.json", "pnpm-lock.yaml"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const dockerLog = join(root, "docker.log"); const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
if test "$1" = "volume"; then
  test "$2" != "rm" || test -f "${artifacts}/results.json" || exit 93
  exit 0
fi
workspace=""; dependencies=""; last=""
for argument in "$@"; do
  case "$argument" in
    type=bind,src=*,dst=/workspace) workspace="\${argument#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace}" ;;
    type=bind,src=*,dst=/workspace/packages/app/node_modules) dependencies="\${argument#type=bind,src=}"; dependencies="\${dependencies%%,dst=*}" ;;
  esac
  last="$argument"
done
test "$last" = "corepack pnpm test" || exit 91
test -x "$dependencies/.bin/fixture-check" || exit 92
test -x "$workspace/packages/app/node_modules/.bin/fixture-check" || exit 94
"$dependencies/.bin/fixture-check"
printf '{"tampered":true}\n' > "$workspace/packages/app/.runforge-workspace-link-owner.json"
`); await chmod(docker, 0o755);
    const specPath = join(root, "task-spec.json");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 2, taskId: "VALIDATION-DEPENDENCY-CAPABILITY-1",
      task: { text: "Run package validation with reusable dependencies.", goal: "Prove dependency capability planning.", acceptanceCriteria: ["Package validation executes"] },
      target: { repository, workingDirectory: "packages/app", expectedSha: head }, execution: { mode: "validation", timeoutMs: 30_000 },
      executionAgreement: { schemaVersion: 1, profile: "assist-only" },
      runtime: { preference: "docker", dockerImage: "runforge:test", dependencyPreparation: "if-needed", externalNetwork: "denied" },
      validation: { mode: "explicit", commands: ["corepack pnpm test"] }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false },
      git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: artifacts },
    }));
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const execution = await runTaskSpecFile(specPath);
      const dockerLifecycle = await readFile(dockerLog, "utf8");
      expect(dockerLifecycle).toContain("volume create --driver local --opt type=tmpfs");
      expect(dockerLifecycle).toContain("type=volume,src=runforge-validation-tmp-validation-dependency-capability-1-");
      expect(dockerLifecycle.trim().split("\n").at(-1)).toMatch(/^volume rm -f runforge-validation-tmp-validation-dependency-capability-1-[a-f0-9]{16}$/);
      expect(dockerLifecycle).toMatch(/type=bind,src=\/[^ ]*runforge-dependencies-[^, ]+,dst=\/workspace\/packages\/app\/node_modules(?: |$)/);
      expect(dockerLifecycle).not.toContain("/source/node_modules");
      expect(execution).toMatchObject({ kind: "validation", success: true, result: { validationAggregate: "passed", source: { unchanged: true } } });
      const result = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"));
      expect(result.validationPlan.commands).toEqual([
        expect.objectContaining({ command: "corepack pnpm test", disposition: "execute", availableCapabilities: expect.arrayContaining(["package-manager", "dependencies"]) }),
      ]);
      expect(result.validation).toEqual([
        expect.objectContaining({ command: "corepack pnpm test", outcome: "passed", lane: "docker-validation", stdout: expect.stringContaining("fixture dependency executable ran") }),
      ]);
      if (!("productWorkspace" in execution.result)) throw new Error("Expected the capability-aware validation-only executor result.");
      await expect(access(join(execution.result.productWorkspace, "packages", "app", "node_modules"))).rejects.toThrow();
      expect(await readFile(join(execution.result.productWorkspace, "packages", "app", ".runforge-workspace-link-owner.json"), "utf8")).toContain("tampered");
      const dependencyMount = dockerLifecycle.match(/type=bind,src=([^, ]*runforge-dependencies-[^, ]+),dst=\/workspace\/packages\/app\/node_modules/)?.[1];
      expect(dependencyMount).toBeTruthy();
      await expect(access(dependencyMount!)).rejects.toThrow();
      expect(dockerLifecycle).toContain("corepack pnpm test");
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()).toBe(head);
      expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repository, encoding: "utf8" }).trim()).toBe("");
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });

  it("runs product checks in Docker, Git evidence in its bound lane, and never spawns unsupported commands", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-validation-only-"))) - 1]!;
    const repository = join(root, "source"); const artifacts = join(root, "artifacts"); const bin = join(root, "bin");
    await mkdir(join(repository, "packages", "app"), { recursive: true }); await mkdir(bin);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "packages", "app", "README.md"), "# fixture\n"); execFileSync("git", ["add", "packages/app/README.md"], { cwd: repository }); execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const workspaceGitCommand = `root="$(git rev-parse --show-toplevel)" && test "$(git rev-parse HEAD)" = "${head}" && test -z "$(git status --porcelain=v1 -uall)" && git -C "$root" worktree add --quiet --detach "$root/.nested-validation" HEAD && test "$(git -C "$root/.nested-validation" rev-parse HEAD)" = "${head}"`;
    const dockerLog = join(root, "docker.log"); const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
test "$1" = "volume" && exit 0
workspace=""; workdir="/workspace"; last=""; next_workdir=0
for argument in "$@"; do if test "$next_workdir" = 1; then workdir="$argument"; next_workdir=0; fi; case "$argument" in --workdir) next_workdir=1 ;; type=bind,src=*,dst=/workspace*) workspace="\${argument#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace*}" ;; esac; last="$argument"; done
relative="\${workdir#/workspace}"; (cd "$workspace$relative" && /bin/sh -lc "$last")
`); await chmod(docker, 0o755);
    const databaseCommand = "runforge-database-probe --read-only";
    const specPath = join(root, "task-spec.json");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 2, taskId: "VALIDATION-ONLY-REGRESSION-1",
      task: { text: "Run exact validation dogfood.", goal: "Prove multi-lane routing.", acceptanceCriteria: ["All supported evidence passes"] },
      target: { repository, workingDirectory: "packages/app", expectedSha: head }, execution: { mode: "validation", timeoutMs: 30_000 },
      executionAgreement: { schemaVersion: 1, profile: "local-ready" },
      runtime: { preference: "docker", dockerImage: "runforge:test", dependencyPreparation: "disabled", externalNetwork: "denied" },
      validation: { mode: "explicit", commands: ["node --version", workspaceGitCommand, "git diff --check", databaseCommand], requirements: [
        { command: "node --version", capabilities: ["filesystem", "shell"], acceptance: "required", evidenceRole: "product-validation" },
        { command: workspaceGitCommand, capabilities: ["filesystem", "shell"], acceptance: "required", evidenceRole: "product-validation" },
        { command: "git diff --check", capabilities: ["git-read-only-evidence"], acceptance: "evidence-only", evidenceRole: "git-evidence" },
        { command: databaseCommand, capabilities: ["database"], acceptance: "optional", evidenceRole: "database-evidence" },
      ] }, authority: { profile: "read-only", allowProviderCalls: false, allowNetwork: false }, git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: artifacts },
    }));
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const execution = await runTaskSpecFile(specPath);
      expect(execution).toMatchObject({ kind: "validation", success: true, result: { status: "completed", validationAggregate: "completed_with_validation_gaps", source: { unchanged: true } } });
      const result = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8"));
      expect(result).toMatchObject({
        status: "workflow_completed",
        validationAggregate: "completed_with_validation_gaps",
        review: {
          structural: { status: "completed_with_validation_gaps" },
          semantic: {
            status: "unavailable",
            delegation: {
              party: "external_session",
              reason: expect.stringContaining("independentReview as not_requested with responsibleParty nobody: Not requested."),
              exactAction: "In external_session, request and perform an independent semantic review, then attach structured findings to this handoff.",
            },
          },
        },
      });
      expect(result.review.semantic.delegation.reason).not.toContain("assigns independent review to runforge");
      expect(result.validation).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "node --version", outcome: "passed", lane: "docker-validation", executor: "docker-shell" }),
        expect.objectContaining({ command: workspaceGitCommand, outcome: "passed", lane: "docker-validation", executor: "docker-shell" }),
        expect.objectContaining({ command: "git diff --check", outcome: "passed", lane: "git-evidence", boundSha: head, safetyAssertions: expect.arrayContaining(["argv_only_no_shell", "source_state_immutable"]) }),
        expect.objectContaining({ command: databaseCommand, outcome: "capability_unsupported", exitCode: null, missingCapabilities: ["database"] }),
      ]));
      const product = result.validation.find((item: { command: string }) => item.command === "node --version");
      await expect(access(join(product.cwd, "..", "..", ".git"))).resolves.toBeUndefined();
      const spawned = await readFile(dockerLog, "utf8"); expect(spawned).not.toContain("git diff --check"); expect(spawned).not.toContain(databaseCommand);
      expect(spawned).toContain("dst=/workspace --workdir /workspace/packages/app");
      for (const responsibleParty of ["owner", "external_session", "external_system"] satisfies ExecutionParty[]) {
        const executionAgreement = negotiateExecutionAgreement({
          profile: "custom",
          requested: { independentReview: true },
          requestedOwnership: { independentReview: responsibleParty },
        });
        await runTaskSpecFile(specPath, { executionAgreement });
        const delegated = JSON.parse(await readFile(join(artifacts, "results.json"), "utf8")).review.semantic.delegation;
        expect(delegated).toEqual({
          party: responsibleParty,
          reason: expect.stringContaining(`independentReview as handoff with responsibleParty ${responsibleParty}: Delegated to ${responsibleParty}; tracked as a handoff.`),
          exactAction: `Have ${responsibleParty} perform the requested independent semantic review and attach structured findings to this handoff.`,
        });
      }
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()).toBe(head);
      expect(execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repository, encoding: "utf8" }).trim()).toBe("");
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});

async function semanticReviewFixture(commands: string[], acceptance: "required" | "optional" = "required", semantic = true) {
  const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-validation-semantic-"))) - 1]!;
  const repository = join(root, "source"), artifacts = join(root, "artifacts"), bin = join(root, "bin");
  await mkdir(join(repository, "src"), { recursive: true }); await mkdir(bin);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "RunForge Test"], { cwd: repository }); execFileSync("git", ["config", "user.email", "runforge@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "src", "review.ts"), "export const reviewedValue = 1;\n");
  execFileSync("git", ["add", "src/review.ts"], { cwd: repository }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const docker = join(bin, "docker"); await writeFile(docker, `#!/bin/sh
if [ "$1" = "volume" ]; then for item in "$@"; do volume="$item"; done; [ "$2" != "create" ] || printf '%s\\n' "$volume"; exit 0; fi
workspace=""; last=""
for item in "$@"; do case "$item" in type=bind,src=*,dst=/workspace*) workspace="\${item#type=bind,src=}"; workspace="\${workspace%%,dst=/workspace*}";; esac; last="$item"; done
[ -n "$workspace" ] || exit 97
(cd "$workspace" && /bin/sh -lc "$last")
`); await chmod(docker, 0o755); process.env.PATH = `${bin}:${originalPath ?? ""}`;
  const specPath = join(root, "task-spec.json");
  await writeFile(specPath, JSON.stringify({
    schemaVersion: 2, taskId: `SEMANTIC-${Math.random().toString(16).slice(2)}`,
    task: { text: "Review src/review.ts without modifying it.", goal: "Validate existing behavior.", acceptanceCriteria: ["Source remains unchanged", "Review is provider-backed"] },
    target: { repository, workingDirectory: ".", expectedSha: head }, execution: { mode: "validation", timeoutMs: 30_000, maxProviderTokens: 4_000 },
    executionAgreement: { schemaVersion: 1, profile: semantic ? "custom" : "assist-only", ...(semantic ? { phaseOwnership: { independentReview: "runforge", providerModelCalls: "runforge" } } : {}) },
    discovery: { profile: "small-scope", explicitFiles: ["src/review.ts"], maxFiles: 2, maxBytes: 8_000, maxTokens: 2_000, stopCondition: "Review only explicit source." },
    runtime: { preference: "docker", dockerImage: "runforge:test", dependencyPreparation: "disabled", externalNetwork: semantic ? "allowed" : "denied" },
    validation: { mode: "explicit", commands, requirements: commands.map((command) => ({ command, capabilities: ["filesystem", "shell"], acceptance, evidenceRole: "product-validation", fallbacks: [] })) },
    authority: { profile: "read-only", allowProviderCalls: semantic, allowNetwork: semantic },
    providerRouting: { provider: semantic ? "openrouter" : "local", fallbackPolicy: "none", models: semantic ? { reviewer: "review/model", logCompression: "compress/model" } : {}, maxCalls: 3, tokenBudget: { total: 4_000, perPhase: { planner: 0, implementer: 0, repair: 0, reviewer: semantic ? 2_000 : 0, logCompression: semantic ? 1_000 : 0 } }, timeoutMs: 30_000, retry: { maxAttempts: 1 } },
    git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, artifacts: { root: artifacts },
  }));
  const spec = await loadTaskSpecV2(specPath);
  const enabled = { projectDiscovery: true, taskAnalysis: true, localValidation: true, independentReview: true, providerModelCalls: true };
  const agreement = negotiateExecutionAgreement({ profile: semantic ? "custom" : "assist-only", requested: semantic ? enabled : { projectDiscovery: true, taskAnalysis: true, localValidation: true }, requestedOwnership: semantic ? { independentReview: "runforge", providerModelCalls: "runforge" } : undefined, technicalCapability: enabled, authority: enabled, policy: enabled });
  return { root, repository, artifacts, specPath, spec, agreement };
}

function immutableSourceSnapshot(repository: string) {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repository, encoding: "utf8" }).trim(),
    refs: execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: repository, encoding: "utf8" }).trim(),
    content: readFileSync(join(repository, "src", "review.ts"), "utf8"),
  };
}

function openRouterResponse(content: string, requestId: string, totalTokens: number, cost: number) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: totalTokens - 2, completion_tokens: 2, total_tokens: totalTokens, cost } }), { status: 200, headers: { "x-request-id": requestId } });
}
