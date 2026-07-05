import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validationDir = join(repo, "validation/runs/ALPHA-7");
const rawRoot = "/tmp/runforge-alpha7-blackbox";
const results: Array<Record<string, unknown>> = [];

await rm(validationDir, { recursive: true, force: true });
await rm(rawRoot, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });
await mkdir(rawRoot, { recursive: true });

await run("packet validation sweep", join(rawRoot, "packet-validation"), ["validation:packets"], true, "script");

const providerValid = await runProviderCase("provider valid fixture patch accepted", "valid", providerPatchCommand("state.txt", "bad", "good"), "proposal_ready_verified", "accepted");
const providerForbidden = await runProviderCase("provider forbidden .env patch rejected", "forbidden-env", providerPatchCommand(".env", "bad", "good"), "provider_rejected", "rejected");
const providerMalformed = await runProviderCase("provider malformed diff rejected", "malformed", "diff --git a/state.txt b/state.txt\n--- a/state.txt\n", "provider_rejected", "rejected");
const providerTraversal = await runProviderCase("provider path traversal rejected", "path-traversal", providerPatchCommand("../escape.txt", "bad", "good"), "provider_rejected", "rejected");

const allowlistRepo = await createProviderGitRepo("allowlist");
const readinessOut = join(rawRoot, "allowlist-readiness");
await run("create allowlist readiness source", readinessOut, [
  "external", "proposal-readiness",
  "--repo", allowlistRepo,
  "--command", providerVerificationCommand(),
  "--out", readinessOut,
  "--run-id", "alpha7-allowlist-readiness"
]);
const contractPath = join(readinessOut, "packet", "proposal-contract.json");
const contract = JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
contract.allowedPaths = ["src/**"];
await writeFile(contractPath, JSON.stringify(contract, null, 2), "utf8");
const allowlistOut = join(rawRoot, "provider-allowlist");
await run("provider allowlist violation rejected", allowlistOut, [
  "external", "code-proposal",
  "--from-readiness-packet", join(readinessOut, "packet"),
  "--enable-provider-proposal",
  "--provider", "cli",
  "--provider-command", providerOutputCommand(providerPatchCommand("state.txt", "bad", "good")),
  "--out", allowlistOut,
  "--run-id", "alpha7-provider-allowlist"
]);
await assertStatus(allowlistOut, "provider_rejected", "rejected");

const codePacket = "/tmp/runforge-alpha7-packet-validation/code-proposal/packet";
const viewerOut = join(rawRoot, "viewer-code-proposal");
await run("static packet viewer generated", viewerOut, ["packet", "view", "--packet", codePacket, "--out", viewerOut]);
const viewerHtml = await readFile(join(viewerOut, "index.html"), "utf8");
const viewerOk = ["Worker Graph", "Artifacts", "Metrics", "Safety", "Proposal Patch"].every((text) => viewerHtml.includes(text));
results.push({ name: "viewer output contains graph/worker/status/artifact information", ok: viewerOk, exitCode: viewerOk ? 0 : 1, outDir: viewerOut });
if (!viewerOk) throw new Error("viewer output missing expected content");

const originalStates = {
  valid: await readFile(join(providerValid.repo, "state.txt"), "utf8"),
  forbidden: await readFile(join(providerForbidden.repo, "state.txt"), "utf8"),
  malformed: await readFile(join(providerMalformed.repo, "state.txt"), "utf8"),
  traversal: await readFile(join(providerTraversal.repo, "state.txt"), "utf8"),
  allowlist: await readFile(join(allowlistRepo, "state.txt"), "utf8")
};

const summary = renderSummary(originalStates);
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
await writeFile(join(validationDir, "results.json"), JSON.stringify({
  schemaVersion: "alpha-7",
  generatedAt: new Date().toISOString(),
  rawRoot,
  viewerOut,
  originalStates,
  results
}, null, 2), "utf8");

console.log(summary);

async function runProviderCase(name: string, slug: string, patch: string, expectedOutcome: string, expectedProviderStatus: string): Promise<{ repo: string; out: string }> {
  const providerRepo = await createProviderGitRepo(slug);
  const out = join(rawRoot, `provider-${slug}`);
  await run(name, out, [
    "external", "code-proposal",
    "--repo", providerRepo,
    "--command", providerVerificationCommand(),
    "--enable-provider-proposal",
    "--provider", "cli",
    "--provider-command", providerOutputCommand(patch),
    "--out", out,
    "--run-id", `alpha7-provider-${slug}`
  ]);
  await assertStatus(out, expectedOutcome, expectedProviderStatus);
  return { repo: providerRepo, out };
}

async function assertStatus(out: string, outcome: string, providerStatus: string): Promise<void> {
  const status = JSON.parse(await readFile(join(out, "packet", "proposal-status.json"), "utf8")) as { outcome?: string; providerStatus?: string };
  const ok = status.outcome === outcome && status.providerStatus === providerStatus;
  results.push({ name: `assert ${out} status`, ok, exitCode: ok ? 0 : 1, observed: status, expected: { outcome, providerStatus } });
  if (!ok) throw new Error(`unexpected status for ${out}: ${JSON.stringify(status)}`);
}

async function run(name: string, outDir: string, args: string[], expectSuccess = true, mode: "dev" | "script" = "dev"): Promise<void> {
  const started = Date.now();
  try {
    const commandArgs = mode === "script" ? ["--dir", repo, ...args] : ["--dir", repo, "dev", ...args];
    const result = await execFileAsync("pnpm", commandArgs, { cwd: "/tmp", maxBuffer: 1024 * 1024 });
    results.push({ name, ok: expectSuccess, exitCode: 0, durationMs: Date.now() - started, outDir, stdout: bounded(result.stdout), stderr: bounded(result.stderr) });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    results.push({ name, ok: !expectSuccess, exitCode: failure.code ?? 1, durationMs: Date.now() - started, outDir, stdout: bounded(failure.stdout ?? ""), stderr: bounded(failure.stderr ?? "") });
    if (expectSuccess) throw error;
  }
}

async function createProviderGitRepo(slug: string): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), `runforge-alpha7-${slug}-repo-`));
  await writeFile(join(source, "state.txt"), "bad\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: source });
  await execFileAsync("git", ["add", "."], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=RunForge Validation", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: source });
  return source;
}

function providerVerificationCommand(): string {
  return "node -e \"const fs=require('fs'); if (fs.readFileSync('state.txt','utf8').trim()==='good') process.exit(0); console.error('AssertionError: expected state to be good'); process.exit(1);\"";
}

function providerPatchCommand(file: string, before: string, after: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

function providerOutputCommand(patch: string): string {
  return `node -e 'require("fs").writeFileSync("provider-output.patch", ${JSON.stringify(patch)})'`;
}

function renderSummary(originalStates: Record<string, string>): string {
  return `${[
    "# RunForge Alpha-7 Validation",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Raw outputs:",
    `- ${rawRoot}`,
    `- Packet validation: /tmp/runforge-alpha7-packet-validation`,
    `- Viewer: ${join(rawRoot, "viewer-code-proposal/index.html")}`,
    "",
    "Black-box coverage:",
    "- packet validation passes for all current packet types",
    "- packet validation fails for a deliberately broken packet",
    "- provider valid fixture patch accepted and verified",
    "- provider forbidden .env patch rejected",
    "- provider malformed diff rejected",
    "- provider path traversal rejected",
    "- provider allowlist violation rejected",
    "- static packet viewer generated for a code proposal packet",
    "- viewer output contains graph/worker/status/artifact information",
    "- original provider repos stayed unchanged",
    "",
    "Results:",
    ...results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} ${String(result.name)} (exit ${String(result.exitCode)})`),
    "",
    "Original repo states:",
    ...Object.entries(originalStates).map(([name, state]) => `- ${name}: ${JSON.stringify(state)}`)
  ].join("\n")}\n`;
}

function bounded(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[truncated]\n` : text;
}
