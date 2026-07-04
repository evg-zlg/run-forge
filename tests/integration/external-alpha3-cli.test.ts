import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("maps deterministic non-ready categories conservatively", async () => {
    const repo = await createSampleGitRepo();
    await expectReadiness(repo, "node -e \"console.error('Cannot find module lodash'); process.exit(1)\"", "needs_more_context", "dependency_missing");
    await expectReadiness(repo, "definitely-not-a-real-command", "needs_more_context", "command_not_found");
    await expectReadiness(repo, "node -e \"setTimeout(() => {}, 2000)\"", "research_only", "timeout", ["--timeout-ms", "100"]);
    await expectReadiness(repo, "node -e \"console.log('ok')\"", "no_failure_observed", "no_failure_observed");
  });

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
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      filesChanged: ["tests/calculator.test.ts"]
    });
    expect(status.patchBytes).toBeGreaterThan(0);
    expect(await readFile(join(packetDir, "proposal.patch"), "utf8")).toContain("+    expect(add(1, 1)).toBe(2);");
    expect(await readFile(join(repo, "tests/calculator.test.ts"), "utf8")).toBe(beforeTest);
    expect(await gitStatus(repo)).toEqual(beforeStatus);
  });

  it("does not generate a patch for not-ready readiness", async () => {
    const triagePacket = await createSyntheticTriagePacket({ category: "dependency_missing" });
    const readinessOut = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-not-ready-source-"));
    const codeOut = await mkdtemp(join(tmpdir(), "runforge-alpha3-code-not-ready-"));
    await runCli(["external", "proposal-readiness", "--from-triage-packet", triagePacket, "--out", readinessOut]);

    await runCli(["external", "code-proposal", "--from-readiness-packet", join(readinessOut, "packet"), "--out", codeOut]);

    const status = JSON.parse(await readFile(join(codeOut, "packet", "proposal-status.json"), "utf8")) as {
      outcome: string;
      patchBytes: number;
    };
    expect(status.outcome).toBe("not_ready");
    expect(status.patchBytes).toBe(0);
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
    };
    expect(status.outcome).toBe("no_safe_proposal");
    expect(status.patchBytes).toBe(0);
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
    };
    expect(status.outcome).toBe("verification_failed");
    expect(status.verificationPassed).toBe(false);
    expect(status.patchBytes).toBeGreaterThan(0);
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

async function expectReadiness(repo: string, command: string, outcome: string, category: string, extraArgs: string[] = []): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha3-readiness-case-"));
  await runCli(["external", "proposal-readiness", "--repo", repo, "--command", command, "--out", outDir, ...extraArgs]);
  const contract = JSON.parse(await readFile(join(outDir, "packet", "proposal-contract.json"), "utf8")) as {
    readinessOutcome: string;
    failureCategory: string;
    canAttemptCodeProposal: boolean;
  };
  expect(contract.readinessOutcome).toBe(outcome);
  expect(contract.failureCategory).toBe(category);
  expect(contract.canAttemptCodeProposal).toBe(outcome === "ready_for_code_proposal");
}

function assertionCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('tests/calculator.test.ts','utf8'); if (text.includes('toBe(2)')) process.exit(0); console.error('AssertionError: expected add(1, 1) assertion to expect 2'); process.exit(1);\"";
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
