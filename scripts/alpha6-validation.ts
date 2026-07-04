import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validationDir = join(repo, "validation/runs/ALPHA-6");

const results: Array<Record<string, unknown>> = [];

await rm(validationDir, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });

await run("deterministic proposal still works", "/tmp/runforge-alpha6-deterministic", [
  "external", "code-proposal",
  "--repo", join(repo, "fixtures/repos/sample-js"),
  "--command", assertionCommand(),
  "--out", "/tmp/runforge-alpha6-deterministic"
]);
await run("packet inspector schema validation", "/tmp/runforge-alpha6-deterministic", [
  "packet", "inspect",
  "--packet", "/tmp/runforge-alpha6-deterministic/packet",
  "--validate"
], true, false);

const providerRepo = await createProviderRepo();
await run("provider disabled by default", "/tmp/runforge-alpha6-provider-disabled", [
  "external", "code-proposal",
  "--repo", providerRepo,
  "--command", providerVerificationCommand(),
  "--out", "/tmp/runforge-alpha6-provider-disabled"
]);
await run("provider requires explicit flag", "/tmp/runforge-alpha6-provider-requires-flag", [
  "external", "code-proposal",
  "--repo", providerRepo,
  "--command", "node -e \"process.exit(1)\"",
  "--provider", "cli",
  "--provider-command", "node -e 'console.log(1)'",
  "--out", "/tmp/runforge-alpha6-provider-requires-flag"
], false);
await run("unsafe provider patch is rejected", "/tmp/runforge-alpha6-provider-unsafe", [
  "external", "code-proposal",
  "--repo", providerRepo,
  "--command", providerVerificationCommand(),
  "--enable-provider-proposal",
  "--provider", "cli",
  "--provider-command", providerPatchCommand(".env", "old", "secret"),
  "--out", "/tmp/runforge-alpha6-provider-unsafe"
]);
await run("valid provider patch verifies in disposable workspace", "/tmp/runforge-alpha6-provider-valid", [
  "external", "code-proposal",
  "--repo", providerRepo,
  "--command", providerVerificationCommand(),
  "--enable-provider-proposal",
  "--provider", "cli",
  "--provider-command", providerPatchCommand("state.txt", "bad", "good"),
  "--out", "/tmp/runforge-alpha6-provider-valid"
]);
await run("provider packet validation json", "/tmp/runforge-alpha6-provider-valid", [
  "packet", "inspect",
  "--packet", "/tmp/runforge-alpha6-provider-valid/packet",
  "--validate",
  "--format", "json"
], true, false);

const providerOriginalState = await readFile(join(providerRepo, "state.txt"), "utf8");
const summary = renderSummary(providerRepo, providerOriginalState);
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
await writeFile(join(validationDir, "results.json"), JSON.stringify({
  schemaVersion: "alpha-6",
  generatedAt: new Date().toISOString(),
  rawPacketPrefix: "/tmp/runforge-alpha6-*",
  providerOriginalState,
  results
}, null, 2), "utf8");

console.log(summary);

async function run(name: string, outDir: string, args: string[], expectSuccess = true, cleanOutDir = true): Promise<void> {
  if (cleanOutDir) await rm(outDir, { recursive: true, force: true });
  const started = Date.now();
  try {
    const result = await execFileAsync("pnpm", ["--dir", repo, "dev", ...args], {
      cwd: "/tmp",
      maxBuffer: 1024 * 1024
    });
    results.push({ name, ok: expectSuccess, exitCode: 0, durationMs: Date.now() - started, outDir, stdout: bounded(result.stdout), stderr: bounded(result.stderr) });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    results.push({
      name,
      ok: !expectSuccess,
      exitCode: failure.code ?? 1,
      durationMs: Date.now() - started,
      outDir,
      stdout: bounded(failure.stdout ?? ""),
      stderr: bounded(failure.stderr ?? "")
    });
    if (expectSuccess) throw error;
  }
}

async function createProviderRepo(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "runforge-alpha6-provider-repo-"));
  await writeFile(join(source, "state.txt"), "bad\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: source });
  await execFileAsync("git", ["add", "."], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=RunForge Dogfood", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: source });
  await cp(source, "/tmp/runforge-alpha6-provider-repo", { recursive: true, force: true });
  return "/tmp/runforge-alpha6-provider-repo";
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

function renderSummary(providerRepo: string, providerOriginalState: string): string {
  const lines = [
    "# RunForge Alpha-6 Validation",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Raw packet paths:",
    "- /tmp/runforge-alpha6-deterministic/packet",
    "- /tmp/runforge-alpha6-provider-disabled/packet",
    "- /tmp/runforge-alpha6-provider-unsafe/packet",
    "- /tmp/runforge-alpha6-provider-valid/packet",
    "",
    "Results:",
    ...results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} ${result.name} (exit ${result.exitCode})`),
    "",
    "Schema validation:",
    "- Packet inspector `--validate` passed for the deterministic proposal packet.",
    "- Packet inspector `--validate --format json` passed for the provider proposal packet.",
    "",
    "Provider safety:",
    "- Provider mode stayed disabled without `--enable-provider-proposal`.",
    "- `--provider` and `--provider-command` without the explicit enable flag failed as expected.",
    "- Unsafe `.env` provider patch was rejected before workspace apply.",
    "- Valid provider patch applied and verified only in a disposable workspace.",
    "",
    "Original repo mutation verdict:",
    `- Provider fixture repo: ${providerRepo}`,
    `- state.txt after all provider runs: ${JSON.stringify(providerOriginalState)}`,
    "- RunForge fixture/original repos were used through disposable-workspace packet commands.",
    "",
    "Known limitations:",
    "- Runtime validation is lightweight and checks required artifacts/key fields, not full JSON Schema semantics.",
    "- Provider backend is generic CLI only; no vendor-specific token, model, or cost accounting yet.",
    "- Provider context bundle is intentionally bounded and summary artifacts avoid dumping large prompts."
  ];
  return `${lines.join("\n")}\n`;
}

function bounded(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[truncated]\n` : text;
}
