import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("external proposal-readiness CLI", () => {
  it("creates a ready_for_code_proposal packet from test assertion evidence", async () => {
    const repo = await createSampleGitRepo();
    const before = await gitStatus(repo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-readiness-ready-"));

    const result = await runCli([
      "external", "proposal-readiness",
      "--repo", repo,
      "--command", assertionCommand(),
      "--out", outDir,
      "--run-id", "alpha3-readiness-ready"
    ]);

    const packetDir = join(outDir, "packet");
    expect(result.stdout).toContain("Outcome: ready_for_code_proposal");
    expect(result.stdout).toContain("Can attempt code proposal: true");
    for (const file of requiredReadinessFiles) await access(join(packetDir, file));

    const contract = JSON.parse(await readFile(join(packetDir, "proposal-contract.json"), "utf8")) as {
      schemaVersion: string;
      readinessOutcome: string;
      canAttemptCodeProposal: boolean;
      failureCategory: string;
      forbiddenActions: string[];
      humanGate: string;
    };
    expect(contract).toMatchObject({
      schemaVersion: "alpha-3b",
      readinessOutcome: "ready_for_code_proposal",
      canAttemptCodeProposal: true,
      failureCategory: "test_assertion_failure",
      humanGate: "required"
    });
    expect(contract.forbiddenActions).toContain("mutate original repo");
    expect(await gitStatus(repo)).toEqual(before);
  });

  it.each([
    {
      name: "a missing dependency as needs_more_context",
      command: "node -e \"console.error('Local package.json exists, but node_modules missing.'); console.error('Cannot find module lodash'); process.exit(1)\"",
      outcome: "needs_more_context",
      category: "dependency_missing",
      recommendedIncludes: "Install or prepare dependencies"
    },
    {
      name: "a TypeScript environment error as needs_more_context",
      // The command is evaluated by a shell; keep synthetic stderr free of
      // backticks so the fixture cannot accidentally execute npm.
      command: "node -e \"console.error(\\\"error TS2688: Cannot find type definition file for 'node'.\\\"); console.error(\\\"error TS2591: Cannot find name 'process'. Try npm i --save-dev @types/node.\\\"); process.exit(1)\"",
      outcome: "needs_more_context",
      category: "environment_error",
      recommendedIncludes: "Install or prepare dependencies"
    },
    {
      name: "a missing command as needs_more_context",
      command: "node -e \"console.error('command not found: definitely-not-a-real-command'); process.exit(127)\"",
      outcome: "needs_more_context",
      category: "command_not_found"
    },
    {
      name: "a timeout as research_only",
      command: "node -e \"setTimeout(() => {}, 2000)\"",
      outcome: "research_only",
      category: "timeout",
      extraArgs: ["--timeout-ms", "100"]
    },
    {
      name: "a successful command as no_failure_observed",
      command: "node -e \"console.log('ok')\"",
      outcome: "no_failure_observed",
      category: "no_failure_observed"
    }
  ])("maps deterministic non-ready category: $name", async ({ command, outcome, category, extraArgs, recommendedIncludes }) => {
    const repo = await createSampleGitRepo();
    const before = await gitStatus(repo);
    await expectReadiness(repo, command, outcome, category, extraArgs, recommendedIncludes);
    expect(await gitStatus(repo)).toEqual(before);
  }, 30_000);

  it("reports blocked_by_safety from a synthetic triage safety blocker", async () => {
    const triagePacket = await createSyntheticTriagePacket({
      category: "test_assertion_failure",
      safetyReport: { blockedCommands: [{ reason: "synthetic safety block" }] }
    });
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-readiness-safety-"));

    await runCli([
      "external", "proposal-readiness",
      "--from-triage-packet", triagePacket,
      "--out", outDir
    ]);

    const contract = JSON.parse(await readFile(join(outDir, "packet", "proposal-contract.json"), "utf8")) as {
      readinessOutcome: string;
      canAttemptCodeProposal: boolean;
      missingContext: string[];
    };
    expect(contract.readinessOutcome).toBe("blocked_by_safety");
    expect(contract.canAttemptCodeProposal).toBe(false);
    expect(contract.missingContext[0]).toContain("Safety report");
  });
});

describe("external code-proposal CLI", () => {
  it("generates and verifies a fixture proposal without mutating the original repo", async () => {
    const repo = await createSampleGitRepo();
    const beforeStatus = await gitStatus(repo);
    const beforeTest = await readFile(join(repo, "tests/calculator.test.ts"), "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-verified-"));

    const result = await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", assertionCommand(),
      "--out", outDir,
      "--run-id", "alpha3-code-verified"
    ]);

    const packetDir = join(outDir, "packet");
    expect(result.stdout).toContain("Outcome: proposal_ready_verified");
    expect(result.stdout).toContain("Verification passed: true");
    for (const file of requiredCodeProposalFiles) await access(join(packetDir, file));

    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      filesChanged: string[];
      patchBytes: number;
      strategy: string;
      reviewerDecision: string;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["tests/calculator.test.ts"],
      strategy: "alpha3_calculator_assertion_fixture",
      reviewerDecision: "accepted_for_human_review"
    });
    expect(status.patchBytes).toBeGreaterThan(0);
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain("+    expect(add(1, 1)).toBe(2);");
    expect(await readFile(join(repo, "tests/calculator.test.ts"), "utf8")).toBe(beforeTest);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("generates and verifies a literal assertion mismatch proposal with worker trace metadata", async () => {
    const repo = await createLiteralMismatchGitRepo();
    const beforeStatus = await gitStatus(repo);
    const beforeTest = await readFile(join(repo, "tests/message.test.ts"), "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha4-code-literal-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", literalMismatchCommand(),
      "--out", outDir,
      "--run-id", "alpha4-code-literal"
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      filesChanged: string[];
      strategy: string;
      reviewerDecision: string;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["tests/message.test.ts"],
      strategy: "test_assertion_literal_mismatch",
      reviewerDecision: "accepted_for_human_review"
    });
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain('+expect(value()).toBe("bar");');
    await expectWorkerTrace(packetDir);
    expect(await readFile(join(repo, "tests/message.test.ts"), "utf8")).toBe(beforeTest);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("generates and verifies a narrow TypeScript missing export alias proposal", async () => {
    const repo = await createMissingExportGitRepo();
    const beforeStatus = await gitStatus(repo);
    const beforeSource = await readFile(join(repo, "src/math.ts"), "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha4-code-export-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", missingExportCommand(),
      "--out", outDir,
      "--run-id", "alpha4-code-export"
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      filesChanged: string[];
      strategy: string;
      reviewerDecision: string;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["src/math.ts"],
      strategy: "typescript_missing_export_alias",
      reviewerDecision: "accepted_for_human_review"
    });
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain("+export { total as sum };");
    await expectWorkerTrace(packetDir);
    expect(await readFile(join(repo, "src/math.ts"), "utf8")).toBe(beforeSource);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("generates and verifies a narrow TypeScript import path rewrite proposal", async () => {
    const repo = await createImportPathGitRepo();
    const beforeStatus = await gitStatus(repo);
    const beforeSource = await readFile(join(repo, "src/app.ts"), "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha5-code-import-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", missingImportCommand(),
      "--out", outDir,
      "--run-id", "alpha5-code-import"
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      filesChanged: string[];
      strategy: string;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["src/app.ts"],
      strategy: "typescript_import_path_rewrite"
    });
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain('-import { total } from "./maths";');
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain('+import { total } from "./math";');
    expect(await readFile(join(repo, "src/app.ts"), "utf8")).toBe(beforeSource);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("generates and verifies a config literal mismatch proposal", async () => {
    const repo = await createConfigMismatchGitRepo();
    const beforeStatus = await gitStatus(repo);
    const beforeConfig = await readFile(join(repo, "config/app.json"), "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha5-code-config-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", configMismatchCommand(),
      "--out", outDir,
      "--run-id", "alpha5-code-config"
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      filesChanged: string[];
      strategy: string;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["config/app.json"],
      strategy: "config_literal_mismatch"
    });
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain('-  "apiBaseUrl": "http://localhost:3001"');
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain('+  "apiBaseUrl": "http://localhost:3000"');
    expect(await readFile(join(repo, "config/app.json"), "utf8")).toBe(beforeConfig);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("returns no_safe_proposal when import path evidence has multiple likely replacements", async () => {
    const repo = await createAmbiguousImportPathGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha5-code-import-ambiguous-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", missingImportCommand(),
      "--out", outDir
    ]);

    const status = JSON.parse(await readFile(join(outDir, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
      strategy: string | null;
    };
    expect(status.outcome).toBe("no_safe_proposal");
    expect(status.patchBytes).toBe(0);
    expect(status.strategy).toBeNull();
  });

  it("inspects a code proposal packet as text, json, and mermaid", async () => {
    const repo = await createLiteralMismatchGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha5-inspect-"));
    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", literalMismatchCommand(),
      "--out", outDir,
      "--run-id", "alpha5-inspect"
    ]);
    const packetDir = join(outDir, "packet");

    const text = await runCli(["packet", "inspect", "--packet", packetDir]);
    expect(text.stdout).toContain("Packet type: code_proposal");
    expect(text.stdout).toContain("Strategy: test_assertion_literal_mismatch");
    expect(text.stdout).toContain("proposal_planner");
    expect(text.stdout).toContain("- human-review.md");

    const json = await runCli(["packet", "inspect", "--packet", packetDir, "--format", "json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      runId: "alpha5-inspect",
      packetType: "code_proposal",
      status: "proposal_ready_verified",
      strategy: "test_assertion_literal_mismatch"
    });

    const mermaid = await runCli(["packet", "inspect", "--packet", packetDir, "--format", "mermaid"]);
    expect(mermaid.stdout).toContain("flowchart TD");
    expect(mermaid.stdout).toContain('["proposal_planner"]');
  }, 15_000);

  it("does not generate a patch for not-ready readiness", async () => {
    const triagePacket = await createSyntheticTriagePacket({ category: "dependency_missing" });
    const readinessOut = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-not-ready-source-"));
    const codeOut = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-not-ready-"));
    await runCli(["external", "proposal-readiness", "--from-triage-packet", triagePacket, "--out", readinessOut]);

    await runCli(["external", "code-proposal", "--from-readiness-packet", join(readinessOut, "packet"), "--out", codeOut]);

    const status = JSON.parse(await readFile(join(codeOut, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
      reviewerDecision: string;
    };
    expect(status.outcome).toBe("not_ready");
    expect(status.patchBytes).toBe(0);
    expect(status.reviewerDecision).toBe("rejected_no_safe_proposal");
  });

  it("does not run provider patch generation for environment setup failures", async () => {
    const repo = await createPlainGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha15-env-not-ready-provider-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", "node -e \"console.error('Local package.json exists, but node_modules missing.'); console.error(\\\"error TS2688: Cannot find type definition file for 'node'.\\\"); process.exit(1)\"",
      "--enable-provider-proposal",
      "--provider", "cli",
      "--provider-command", providerPatchCommand(".env", "old", "secret"),
      "--out", outDir
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
      providerStatus: string;
      diagnostics: string[];
    };
    expect(status.outcome).toBe("not_ready");
    expect(status.patchBytes).toBe(0);
    expect(status.providerStatus).toBe("not_run");
    expect(status.diagnostics.join("\n")).toContain("code proposal is not allowed");
    await expect(access(join(packetDir, "provider-safety-report.json"))).rejects.toThrow();
  });

  it("returns no_safe_proposal when the ready failure has no deterministic patch rule", async () => {
    const repo = await createPlainGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-no-safe-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", "node -e \"console.error('TS2322: Type string is not assignable to type number'); process.exit(1)\"",
      "--out", outDir
    ]);

    const status = JSON.parse(await readFile(join(outDir, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
      reviewerDecision: string;
    };
    expect(status.outcome).toBe("no_safe_proposal");
    expect(status.patchBytes).toBe(0);
    expect(status.reviewerDecision).toBe("rejected_no_safe_proposal");
  });

  it("reports verification_failed honestly when the patch does not satisfy the verification command", async () => {
    const repo = await createSampleGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-verification-failed-"));

    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", "node -e \"console.error('AssertionError: expected 1 to equal 2'); process.exit(1)\"",
      "--out", outDir
    ]);

    const status = JSON.parse(await readFile(join(outDir, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      patchBytes: number;
      reviewerDecision: string;
    };
    expect(status.outcome).toBe("verification_failed");
    expect(status.verificationPassed).toBe(false);
    expect(status.patchBytes).toBeGreaterThan(0);
    expect(status.reviewerDecision).toBe("rejected_verification_failed");
  });
});

const requiredReadinessFiles = [
  "summary.md",
  "human-review.md",
  "proposal-readiness.md",
  "proposal-contract.json",
  "missing-context.md",
  "recommended-next-action.md",
  "run.json",
  "events.jsonl",
  "metrics.json",
  "safety-report.json",
  "trajectory.json",
  "packet-manifest.json"
];

const requiredCodeProposalFiles = [
  "summary.md",
  "human-review.md",
  "proposal.patch",
  "patch-summary.md",
  "proposal-status.json",
  "verification-results.json",
  "worker-notes/readiness-loader.md",
  "worker-notes/context-scout.md",
  "worker-notes/failure-analyst.md",
  "worker-notes/proposal-planner.md",
  "worker-notes/patch-writer.md",
  "worker-notes/verifier.md",
  "worker-notes/proposal-reviewer.md",
  "worker-notes/packet-writer.md",
  "before-command-results.json",
  "after-command-results.json",
  "run.json",
  "events.jsonl",
  "metrics.json",
  "safety-report.json",
  "trajectory.json",
  "packet-manifest.json"
];

function runCli(args: string[]) {
  return execFileAsync("pnpm", ["exec", "tsx", "src/cli/index.ts", ...args], {
    cwd: resolve("."),
    maxBuffer: 1024 * 1024
  });
}

async function expectReadiness(repo: string, command: string, outcome: string, category: string, extraArgs: string[] = [], recommendedIncludes?: string): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-readiness-case-"));
  await runCli(["external", "proposal-readiness", "--repo", repo, "--command", command, "--out", outDir, ...extraArgs]);
  const contract = JSON.parse(await readFile(join(outDir, "packet", "proposal-contract.json"), "utf8")) as {
    readinessOutcome: string;
    failureCategory: string;
    canAttemptCodeProposal: boolean;
    recommendedNextAction?: string;
  };
  expect(contract.readinessOutcome).toBe(outcome);
  expect(contract.failureCategory).toBe(category);
  expect(contract.canAttemptCodeProposal).toBe(outcome === "ready_for_code_proposal");
  if (recommendedIncludes) expect(contract.recommendedNextAction).toContain(recommendedIncludes);
}

function assertionCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('tests/calculator.test.ts','utf8'); if (text.includes('toBe(2)')) process.exit(0); console.error('AssertionError: expected add(1, 1) assertion to expect 2'); process.exit(1);\"";
}

function literalMismatchCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('tests/message.test.ts','utf8'); if (text.includes('toBe(\\\"bar\\\")')) process.exit(0); console.error('FAIL tests/message.test.ts'); console.error('Expected: \\\"foo\\\"'); console.error('Received: \\\"bar\\\"'); process.exit(1);\"";
}

function missingExportCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('src/math.ts','utf8'); if (text.includes('export { total as sum };')) process.exit(0); console.error(\\\"src/app.ts(1,10): error TS2305: Module './src/math' has no exported member 'sum'. Did you mean 'total'?\\\"); process.exit(1);\"";
}

function missingImportCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('src/app.ts','utf8'); if (text.includes('from \\\"./math\\\"')) process.exit(0); console.error(\\\"src/app.ts(1,23): error TS2307: Cannot find module './maths' or its corresponding type declarations.\\\"); process.exit(1);\"";
}

function configMismatchCommand(): string {
  return "node -e \"const fs=require('fs'); const config=JSON.parse(fs.readFileSync('config/app.json','utf8')); if (config.apiBaseUrl === 'http://localhost:3000') process.exit(0); console.error('FAIL tests/config.test.ts'); console.error('Config apiBaseUrl mismatch'); console.error('Expected: \\\"http://localhost:3000\\\"'); console.error('Received: \\\"http://localhost:3001\\\"'); process.exit(1);\"";
}

function providerPatchCommand(file: string, before: string, after: string): string {
  const patch = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
  return `node -e 'require("fs").writeFileSync("provider-output.patch", ${JSON.stringify(patch)})'`;
}

async function createSampleGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha3-sample-repo-"));
  await cp(resolve("fixtures/repos/sample-js"), repo, { recursive: true });
  await initGitRepo(repo);
  return repo;
}

async function createPlainGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha3-plain-repo-"));
  await writeFile(join(repo, "README.md"), "# Plain\n", "utf8");
  await initGitRepo(repo);
  return repo;
}

async function createLiteralMismatchGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha4-literal-repo-"));
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests/message.test.ts"), [
    'function value() { return "bar"; }',
    'expect(value()).toBe("foo");',
    ""
  ].join("\n"), "utf8");
  await initGitRepo(repo);
  return repo;
}

async function createMissingExportGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha4-export-repo-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/math.ts"), [
    "export function total(left: number, right: number): number {",
    "  return left + right;",
    "}",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(repo, "src/app.ts"), [
    'import { sum } from "./math";',
    "console.log(sum(1, 2));",
    ""
  ].join("\n"), "utf8");
  await initGitRepo(repo);
  return repo;
}

async function createImportPathGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha5-import-repo-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/math.ts"), [
    "export function total(left: number, right: number): number {",
    "  return left + right;",
    "}",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(repo, "src/app.ts"), [
    'import { total } from "./maths";',
    "console.log(total(1, 2));",
    ""
  ].join("\n"), "utf8");
  await initGitRepo(repo);
  return repo;
}

async function createAmbiguousImportPathGitRepo(): Promise<string> {
  const repo = await createImportPathGitRepo();
  await writeFile(join(repo, "src/maths2.ts"), "export const other = 1;\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Test", "-c", "user.email=runforge@example.test", "commit", "-m", "ambiguous import candidate"], { cwd: repo });
  return repo;
}

async function createConfigMismatchGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha5-config-repo-"));
  await mkdir(join(repo, "config"), { recursive: true });
  await writeFile(join(repo, "config/app.json"), [
    "{",
    '  "apiBaseUrl": "http://localhost:3001"',
    "}",
    ""
  ].join("\n"), "utf8");
  await initGitRepo(repo);
  return repo;
}

async function expectWorkerTrace(packetDir: string): Promise<void> {
  for (const file of requiredCodeProposalFiles) await access(join(packetDir, file));
  const events = (await readFile(join(packetDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; workerId?: string; workerRole?: string; outputArtifactPaths?: string[] });
  const finishedRoles = events.filter((event) => event.type === "worker_finished").map((event) => event.workerRole);
  expect(finishedRoles).toEqual(expect.arrayContaining([
    "readiness_loader",
    "context_scout",
    "failure_analyst",
    "proposal_planner",
    "patch_writer",
    "verifier",
    "proposal_reviewer",
    "packet_writer"
  ]));
  expect(events.filter((event) => event.type === "worker_started").every((event) => event.workerId && event.workerRole)).toBe(true);
  expect(events.filter((event) => event.type === "worker_finished").every((event) => event.workerId && event.workerRole && event.outputArtifactPaths?.length)).toBe(true);
  const trajectory = JSON.parse(await readFile(join(packetDir, "trajectory.json"), "utf8")) as { steps: Array<{ workerRole?: string }> };
  expect(trajectory.steps.map((step) => step.workerRole)).toEqual(expect.arrayContaining(["proposal_reviewer", "packet_writer"]));
}

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Test", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });
}

async function gitStatus(repo: string): Promise<string> {
  const result = await execFileAsync("git", ["status", "--short"], { cwd: repo });
  return result.stdout.trim();
}

async function createSyntheticTriagePacket(input: {
  category: string;
  safetyReport?: Record<string, unknown>;
}): Promise<string> {
  const packetDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-synthetic-triage-"));
  await writeFile(join(packetDir, "root-cause.json"), JSON.stringify({
    schemaVersion: "alpha-3a",
    sourceCheckPacket: null,
    category: input.category,
    confidence: "high",
    requiresMoreContext: input.category !== "test_assertion_failure",
    readyForCodeProposal: input.category === "test_assertion_failure",
    safeNextAction: "Synthetic next action.",
    evidenceBasis: ["Synthetic evidence."]
  }, null, 2), "utf8");
  await writeFile(join(packetDir, "run.json"), JSON.stringify({
    schemaVersion: "alpha-3a",
    status: input.category === "no_failure_observed" ? "no_failure_observed" : "triaged",
    category: input.category,
    confidence: "high"
  }, null, 2), "utf8");
  await writeFile(join(packetDir, "safety-report.json"), JSON.stringify({
    schemaVersion: "alpha-3a",
    noPushAttempted: true,
    noMergeAttempted: true,
    noDeployAttempted: true,
    noApplyToOriginalRepoAttempted: true,
    ...input.safetyReport
  }, null, 2), "utf8");
  return packetDir;
}
