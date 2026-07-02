import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("external docs-proposal CLI", () => {
  it("builds a complete proposal-only packet from flags without a hand-written RunSpec", async () => {
    const externalRepo = await copyExternalDocsFixture();
    const before = await externalDocsSnapshot(externalRepo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-docs-cli-"));

    const result = await runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--evidence", "README.md",
      "--evidence", "package.json",
      "--evidence", "docs/BUILD_STABILITY.md",
      "--anchor", "npm run dev\n```",
      "--insert", "\n\nFor the stable frontend dev path, use the existing root command:\n\n```bash\nnpm run dev:stable\n```",
      "--rationale", "`package.json` exposes a root `dev:stable` script, and docs/BUILD_STABILITY.md documents it.",
      "--out", outDir,
      "--run-id", "external-docs-cli-test",
      "--artifact-namespace", "tests"
    ]);

    expect(result.stdout).toContain("RunForge external docs proposal packet ready.");
    expect(result.stdout).toContain("RunForge version: 0.1.0");
    expect(result.stdout).toContain("RunForge git SHA:");
    expect(result.stdout).toContain(`Packet directory: ${join(outDir, "packet")}`);
    expect(result.stdout).toContain("Proposal outcome: proposal_ready");
    expect(result.stdout).toContain("Human decision required: yes");
    expect(result.stdout).toContain(`human-review.md: ${join(outDir, "packet", "human-review.md")}`);
    expect(result.stdout).toContain(`proposal-status.json: ${join(outDir, "packet", "proposal-status.json")}`);
    expect(result.stdout).toContain(`proposal.patch: ${join(outDir, "packet", "proposal.patch")}`);
    expect(result.stdout).toContain(`patch-summary.md: ${join(outDir, "packet", "patch-summary.md")}`);
    expect(result.stdout).toContain(`context-pack.md: ${join(outDir, "packet", "context-pack.md")}`);
    expect(result.stdout).toContain("Suggested check: git apply --check");
    expect(result.stdout).toContain("proposal.patch was not applied");
    expect(result.stdout).not.toContain("RunForge blocked: proposal_ready");

    const packetDir = join(outDir, "packet");
    for (const file of [
      "human-review.md",
      "proposal-status.json",
      "proposal.patch",
      "patch-summary.md",
      "safety-report.json",
      "trajectory.json",
      "run-spec.json",
      "context-pack.json",
      "context-pack.md"
    ]) {
      await access(join(packetDir, file));
    }

    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      outcome: string;
      evidenceFiles: string[];
      patchBytes: number;
    };
    expect(status).toMatchObject({
      outcome: "proposal_ready",
      evidenceFiles: ["README.md", "package.json", "docs/BUILD_STABILITY.md"]
    });

    const patch = await readFile(join(packetDir, "proposal.patch"), "utf8");
    expect(patch.length).toBeGreaterThan(0);
    expect(status.patchBytes).toBe(Buffer.byteLength(patch, "utf8"));
    expect(patch).toContain("diff --git a/README.md b/README.md");
    expect(patch).toContain("+npm run dev:stable");
    await execFileAsync("git", ["apply", "--check", join(packetDir, "proposal.patch")], { cwd: externalRepo });

    const spec = JSON.parse(await readFile(join(packetDir, "run-spec.json"), "utf8")) as {
      allowExternalRepo?: boolean;
      docsProposal?: { allowExternalRepo?: boolean; include?: string[]; evidenceFiles?: string[] };
      safetyProfile?: string;
      applyMode?: string;
    };
    expect(spec).toMatchObject({
      allowExternalRepo: true,
      safetyProfile: "safe-local",
      applyMode: "patch-artifact",
      docsProposal: {
        allowExternalRepo: true,
        include: ["README.md", "package.json", "docs/BUILD_STABILITY.md"],
        evidenceFiles: ["README.md", "package.json", "docs/BUILD_STABILITY.md"]
      }
    });
    expect(await externalDocsSnapshot(externalRepo)).toEqual(before);
  });

  it("accepts anchor, insert, and rationale from files while preserving multiline insert text", async () => {
    const externalRepo = await copyExternalDocsFixture();
    const before = await externalDocsSnapshot(externalRepo);
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-docs-cli-files-out-"));
    const inputDir = await mkdtemp(join(tmpdir(), "runforge-external-docs-cli-files-input-"));
    const anchor = "npm run dev\n```";
    const insert = "\n\nFor the stable frontend dev path, use the existing root command:\n\n```bash\nnpm run dev:stable\n```\n\nThis keeps day-to-day local runs on the documented stable path.\n";
    const rationale = "`package.json` exposes a root `dev:stable` script.\n`docs/BUILD_STABILITY.md` documents it as stable.\n";
    const anchorFile = join(inputDir, "anchor.txt");
    const insertFile = join(inputDir, "insert.md");
    const rationaleFile = join(inputDir, "rationale.md");
    await writeFile(anchorFile, anchor, "utf8");
    await writeFile(insertFile, insert, "utf8");
    await writeFile(rationaleFile, rationale, "utf8");

    const result = await runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--evidence", "README.md",
      "--evidence", "package.json",
      "--evidence", "docs/BUILD_STABILITY.md",
      "--anchor-file", anchorFile,
      "--insert-file", insertFile,
      "--rationale-file", rationaleFile,
      "--out", outDir,
      "--run-id", "external-docs-cli-file-test",
      "--artifact-namespace", "tests"
    ]);

    expect(result.stdout).toContain("Proposal outcome: proposal_ready");

    const packetDir = join(outDir, "packet");
    const status = JSON.parse(await readFile(join(packetDir, "proposal-status.json"), "utf8")) as {
      executionStatus: string;
      proposalOutcome: string;
      humanGate: string;
      runStatus: string;
      outcome: string;
    };
    expect(status).toMatchObject({
      executionStatus: "completed",
      proposalOutcome: "proposal_ready",
      humanGate: "required",
      runStatus: "blocked",
      outcome: "proposal_ready"
    });

    const spec = JSON.parse(await readFile(join(packetDir, "run-spec.json"), "utf8")) as {
      docsProposal?: { anchorText?: string; insertedText?: string; rationale?: string };
    };
    expect(spec.docsProposal?.anchorText).toBe(anchor);
    expect(spec.docsProposal?.insertedText).toBe(insert);
    expect(spec.docsProposal?.rationale).toBe(rationale);

    const patch = await readFile(join(packetDir, "proposal.patch"), "utf8");
    expect(patch).toContain("+This keeps day-to-day local runs on the documented stable path.");
    await execFileAsync("git", ["apply", "--check", join(packetDir, "proposal.patch")], { cwd: externalRepo });
    expect(await externalDocsSnapshot(externalRepo)).toEqual(before);
  });

  it("fails with a useful error when a required flag is missing", async () => {
    const externalRepo = await copyExternalDocsFixture();
    await expect(runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--anchor", "npm run dev\n```",
      "--insert", "\n\nDocument the stable dev command."
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("At least one --evidence file is required.")
    });
  });

  it("rejects direct and file input for the same text field", async () => {
    const externalRepo = await copyExternalDocsFixture();
    const inputDir = await mkdtemp(join(tmpdir(), "runforge-external-docs-cli-conflict-"));
    const anchorFile = join(inputDir, "anchor.txt");
    await writeFile(anchorFile, "npm run dev\n```", "utf8");

    await expect(runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--evidence", "README.md",
      "--anchor", "npm run dev\n```",
      "--anchor-file", anchorFile,
      "--insert", "\n\nDocument the stable dev command."
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--anchor and --anchor-file are mutually exclusive.")
    });
  });

  it("fails with a useful error when a file input is missing", async () => {
    const externalRepo = await copyExternalDocsFixture();

    await expect(runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--evidence", "README.md",
      "--anchor-file", join(tmpdir(), "runforge-missing-anchor.txt"),
      "--insert", "\n\nDocument the stable dev command."
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--anchor-file file does not exist:")
    });
  });

  it("fails fast when an evidence file is missing and writes no false proposal", async () => {
    const externalRepo = await copyExternalDocsFixture();
    const outDir = await mkdtemp(join(tmpdir(), "runforge-external-docs-cli-missing-"));
    await rm(join(externalRepo, "docs/BUILD_STABILITY.md"));

    await expect(runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "README.md",
      "--evidence", "README.md",
      "--evidence", "package.json",
      "--evidence", "docs/BUILD_STABILITY.md",
      "--anchor", "npm run dev\n```",
      "--insert", "\n\nDocument the stable dev command.",
      "--out", outDir
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--evidence file does not exist: docs/BUILD_STABILITY.md")
    });

    await expect(access(join(outDir, "packet", "proposal.patch"))).rejects.toThrow();
  });

  it("rejects unsafe path traversal before running a proposal", async () => {
    const externalRepo = await copyExternalDocsFixture();
    await expect(runCli([
      "external",
      "docs-proposal",
      "--repo", externalRepo,
      "--target", "../README.md",
      "--evidence", "README.md",
      "--anchor", "anchor",
      "--insert", "insert"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--target must stay inside --repo")
    });
  });
});

function runCli(args: string[]) {
  return execFileAsync("pnpm", ["exec", "tsx", "src/cli/index.ts", ...args], {
    cwd: resolve("."),
    maxBuffer: 1024 * 1024
  });
}

async function copyExternalDocsFixture(): Promise<string> {
  const externalRepo = await mkdtemp(join(tmpdir(), "runforge-external-docs-repo-"));
  await cp(resolve("tests/fixtures/external-docs-repo"), externalRepo, { recursive: true });
  return externalRepo;
}

async function externalDocsSnapshot(repoPath: string): Promise<Record<string, string>> {
  const files = ["README.md", "package.json", "docs/BUILD_STABILITY.md"];
  const snapshot: Record<string, string> = {};
  for (const file of files) snapshot[file] = await readFile(join(repoPath, file), "utf8");
  return snapshot;
}
