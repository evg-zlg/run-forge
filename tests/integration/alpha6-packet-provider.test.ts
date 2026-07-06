import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validatePacket } from "../../src/run/packet-validator.js";

const execFileAsync = promisify(execFile);

describe("Alpha-6 packet validation", () => {
  it("validates check, triage, readiness, and code proposal packets", async () => {
    const repo = await createSampleGitRepo();
    const checkOut = await mkdtemp(join(tmpdir(), "runforge-alpha6-check-"));
    const triageOut = await mkdtemp(join(tmpdir(), "runforge-alpha6-triage-"));
    const readinessOut = await mkdtemp(join(tmpdir(), "runforge-alpha6-readiness-"));
    const codeOut = await mkdtemp(join(tmpdir(), "runforge-alpha6-code-"));

    await runCli(["external", "check", "--repo", repo, "--command", assertionCommand(), "--out", checkOut, "--run-id", "alpha6-check"]);
    await runCli(["external", "failure-triage", "--from-check-packet", join(checkOut, "packet"), "--out", triageOut, "--run-id", "alpha6-triage"]);
    await runCli(["external", "proposal-readiness", "--from-triage-packet", join(triageOut, "packet"), "--out", readinessOut, "--run-id", "alpha6-readiness"]);
    await runCli(["external", "code-proposal", "--from-readiness-packet", join(readinessOut, "packet"), "--out", codeOut, "--run-id", "alpha6-code"]);

    for (const packet of [checkOut, triageOut, readinessOut, codeOut].map((out) => join(out, "packet"))) {
      await expect(validatePacket(packet)).resolves.toMatchObject({ passed: true, errors: [] });
    }
  });

  it("reports missing artifacts, missing JSON fields, and inspector validation output", async () => {
    const repo = await createSampleGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha6-inspect-"));
    await runCli(["external", "check", "--repo", repo, "--command", "node --version", "--out", outDir, "--run-id", "alpha6-inspect"]);
    const packetDir = join(outDir, "packet");

    const text = await runCli(["packet", "inspect", "--packet", packetDir, "--validate"]);
    expect(text.stdout).toContain("Validation: passed");
    const json = await runCli(["packet", "inspect", "--packet", packetDir, "--validate", "--format", "json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ validation: { passed: true, errors: [] } });

    const missingArtifact = await copyPacket(packetDir);
    await rm(join(missingArtifact, "safety-report.json"));
    await expect(validatePacket(missingArtifact)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["missing safety-report.json"]) });

    const missingField = await copyPacket(packetDir);
    const run = JSON.parse(await readFile(join(missingField, "run.json"), "utf8")) as Record<string, unknown>;
    delete run.runId;
    await writeFile(join(missingField, "run.json"), JSON.stringify(run, null, 2), "utf8");
    await expect(validatePacket(missingField)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["run.json missing runId"]) });

    const wrongType = await copyPacket(packetDir);
    const wrongTypeRun = JSON.parse(await readFile(join(wrongType, "run.json"), "utf8")) as Record<string, unknown>;
    wrongTypeRun.durationMs = "soon";
    await writeFile(join(wrongType, "run.json"), JSON.stringify(wrongTypeRun, null, 2), "utf8");
    await expect(validatePacket(wrongType)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["run.json durationMs must be a finite number"]) });
  });
});

describe("Alpha-6 gated provider proposal", () => {
  it("keeps provider mode disabled by default and requires the explicit flag", async () => {
    const repo = await createProviderGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-disabled-"));
    await runCli(["external", "code-proposal", "--repo", repo, "--command", providerVerificationCommand(), "--out", outDir]);
    const status = JSON.parse(await readFile(join(outDir, "packet", "proposal-status.json"), "utf8")) as { outcome: string; providerEnabled: boolean };
    expect(status.outcome).toBe("no_safe_proposal");
    expect(status.providerEnabled).toBe(false);

    const rejected = await runCliAllowFailure([
      "external", "code-proposal",
      "--repo", repo,
      "--command", providerVerificationCommand(),
      "--provider", "cli",
      "--provider-command", "node -e \"console.log('noop')\"",
      "--out", await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-flag-required-"))
    ]);
    expect(rejected.stderr).toContain("--provider and --provider-command require --enable-provider-proposal");
  });

  it("rejects unsafe provider patches before workspace apply", async () => {
    const repo = await createProviderGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-unsafe-"));
    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", providerVerificationCommand(),
      "--enable-provider-proposal",
      "--provider", "cli",
      "--provider-command", providerPatchCommand(".env", "old", "secret"),
      "--out", outDir
    ]);
    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as { outcome: string; providerStatus: string; patchBytes: number };
    expect(status).toMatchObject({ outcome: "provider_rejected", providerStatus: "rejected", patchBytes: 0 });
    const safety = JSON.parse(await readFile(join(packetDir, "provider-safety-report.json"), "utf8")) as {
      rejectionReason: string;
      forbiddenPaths: string[];
    };
    expect(safety.rejectionReason).toContain("patch touches forbidden path: .env");
    expect(safety.forbiddenPaths).toEqual([...new Set(safety.forbiddenPaths)]);
    expect(await readFile(join(repo, "state.txt"), "utf8")).toBe("bad\n");
  });

  it("accepts a valid provider patch, verifies it in a disposable workspace, and leaves the original repo untouched", async () => {
    const repo = await createProviderGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-valid-"));
    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", providerVerificationCommand(),
      "--enable-provider-proposal",
      "--provider", "cli",
      "--provider-command", providerPatchCommand("state.txt", "bad", "good"),
      "--out", outDir,
      "--run-id", "alpha6-provider-valid"
    ]);

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      verificationPassed: boolean;
      strategy: string;
      providerStatus: string;
      providerEnabled: boolean;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready_verified",
      verificationPassed: true,
      strategy: "provider_cli",
      providerStatus: "accepted",
      providerEnabled: true
    });
    expect(await readFile(join(repo, "state.txt"), "utf8")).toBe("bad\n");
    await expect(validatePacket(packetDir)).resolves.toMatchObject({ passed: true });
    const providerSafety = JSON.parse(await readFile(join(packetDir, "provider-safety-report.json"), "utf8")) as {
      status: string;
      providerAudit: { backend: string; commandHash: string; inputBytes: number; outputBytes: number; accepted: boolean; tokenUsage: null; estimatedCost: null };
    };
    expect(providerSafety.status).toBe("accepted");
    expect(providerSafety.providerAudit).toMatchObject({
      backend: "cli",
      accepted: true,
      tokenUsage: null,
      estimatedCost: null
    });
    expect(providerSafety.providerAudit.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(providerSafety.providerAudit.inputBytes).toBeGreaterThan(0);
    expect(providerSafety.providerAudit.outputBytes).toBeGreaterThan(0);
  });

  it("rejects schema-invalid code proposal packets", async () => {
    const repo = await createProviderGitRepo();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-alpha8-schema-provider-"));
    await runCli([
      "external", "code-proposal",
      "--repo", repo,
      "--command", providerVerificationCommand(),
      "--enable-provider-proposal",
      "--provider", "cli",
      "--provider-command", providerPatchCommand("state.txt", "bad", "good"),
      "--out", outDir,
      "--run-id", "alpha8-schema-provider"
    ]);
    const packetDir = join(outDir, "packet");

    const invalidOutcome = await copyPacket(packetDir);
    const status = JSON.parse(await readFile(join(invalidOutcome, "proposal-status.json"), "utf8")) as Record<string, unknown>;
    status.outcome = "maybe_later";
    await writeFile(join(invalidOutcome, "proposal-status.json"), JSON.stringify(status, null, 2), "utf8");
    await expect(validatePacket(invalidOutcome)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["proposal-status.json invalid outcome maybe_later"]) });

    const missingManifestReference = await copyPacket(packetDir);
    const manifest = JSON.parse(await readFile(join(missingManifestReference, "packet-manifest.json"), "utf8")) as { artifacts: Array<Record<string, unknown>> };
    manifest.artifacts.push({ path: "ghost.json", type: "json", sizeBytes: 1, hash: "abc", createdAt: new Date().toISOString() });
    await writeFile(join(missingManifestReference, "packet-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await expect(validatePacket(missingManifestReference)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["missing ghost.json"]) });

    const missingProviderAudit = await copyPacket(packetDir);
    const providerStatus = JSON.parse(await readFile(join(missingProviderAudit, "proposal-status.json"), "utf8")) as Record<string, unknown>;
    delete providerStatus.providerAudit;
    await writeFile(join(missingProviderAudit, "proposal-status.json"), JSON.stringify(providerStatus, null, 2), "utf8");
    await expect(validatePacket(missingProviderAudit)).resolves.toMatchObject({ passed: false, errors: expect.arrayContaining(["proposal-status.json providerAudit missing providerAudit"]) });
  });
});

function runCli(args: string[]) {
  return execFileAsync("pnpm", ["exec", "tsx", "src/cli/index.ts", ...args], {
    cwd: resolve("."),
    maxBuffer: 1024 * 1024
  });
}

async function runCliAllowFailure(args: string[]) {
  try {
    const result = await runCli(args);
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

async function createSampleGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha6-sample-repo-"));
  await cp(resolve("fixtures/repos/sample-js"), repo, { recursive: true });
  await initGitRepo(repo);
  return repo;
}

async function createProviderGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-repo-"));
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "state.txt"), "bad\n", "utf8");
  await initGitRepo(repo);
  return repo;
}

async function copyPacket(packetDir: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "runforge-alpha6-packet-copy-"));
  await cp(packetDir, copy, { recursive: true });
  return copy;
}

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=RunForge Test", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: repo });
}

function assertionCommand(): string {
  return "node -e \"const fs=require('fs'); const text=fs.readFileSync('tests/calculator.test.ts','utf8'); if (text.includes('toBe(2)')) process.exit(0); console.error('AssertionError: expected add(1, 1) assertion to expect 2'); process.exit(1);\"";
}

function providerVerificationCommand(): string {
  return "node -e \"const fs=require('fs'); if (fs.readFileSync('state.txt','utf8').trim()==='good') process.exit(0); console.error('AssertionError: expected state to be good'); process.exit(1);\"";
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
