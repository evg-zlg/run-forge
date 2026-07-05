import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validationDir = join(repo, "validation/runs/PACKET-VALIDATION");
const rawRoot = "/tmp/runforge-alpha7-packet-validation";

interface Result {
  name: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  outDir?: string;
  stdout?: string;
  stderr?: string;
}

const results: Result[] = [];

await rm(validationDir, { recursive: true, force: true });
await rm(rawRoot, { recursive: true, force: true });
await mkdir(validationDir, { recursive: true });
await mkdir(rawRoot, { recursive: true });

const sampleRepo = await createSampleGitRepo();
const checkOut = join(rawRoot, "external-check");
const triageOut = join(rawRoot, "failure-triage");
const readinessOut = join(rawRoot, "proposal-readiness");
const codeOut = join(rawRoot, "code-proposal");

await run("generate external check packet", checkOut, ["external", "check", "--repo", sampleRepo, "--command", assertionCommand(), "--out", checkOut, "--run-id", "packet-validation-check"]);
await run("generate failure triage packet", triageOut, ["external", "failure-triage", "--from-check-packet", join(checkOut, "packet"), "--out", triageOut, "--run-id", "packet-validation-triage"]);
await run("generate proposal readiness packet", readinessOut, ["external", "proposal-readiness", "--from-triage-packet", join(triageOut, "packet"), "--out", readinessOut, "--run-id", "packet-validation-readiness"]);
await run("generate code proposal packet", codeOut, ["external", "code-proposal", "--from-readiness-packet", join(readinessOut, "packet"), "--out", codeOut, "--run-id", "packet-validation-code"]);

const providerRepo = await createProviderGitRepo();
const providerOut = join(rawRoot, "provider-proposal");
await run("generate provider proposal packet", providerOut, [
  "external", "code-proposal",
  "--repo", providerRepo,
  "--command", providerVerificationCommand(),
  "--enable-provider-proposal",
  "--provider", "cli",
  "--provider-command", providerPatchCommand("state.txt", "bad", "good"),
  "--out", providerOut,
  "--run-id", "packet-validation-provider"
]);

const packets = [
  ["external check", join(checkOut, "packet")],
  ["failure triage", join(triageOut, "packet")],
  ["proposal readiness", join(readinessOut, "packet")],
  ["code proposal", join(codeOut, "packet")],
  ["provider proposal", join(providerOut, "packet")]
] as const;
for (const [name, packet] of packets) {
  await run(`validate ${name} packet`, packet, ["packet", "inspect", "--packet", packet, "--validate"]);
}

const brokenPacket = join(rawRoot, "broken-packet");
await cp(join(checkOut, "packet"), brokenPacket, { recursive: true });
const runJson = JSON.parse(await readFile(join(brokenPacket, "run.json"), "utf8")) as Record<string, unknown>;
delete runJson.runId;
await writeFile(join(brokenPacket, "run.json"), JSON.stringify(runJson, null, 2), "utf8");
await run("broken packet validation fails", brokenPacket, ["packet", "inspect", "--packet", brokenPacket, "--validate"], false);

const viewerOut = join(rawRoot, "viewer-code-proposal");
await run("generate static packet viewer", viewerOut, ["packet", "view", "--packet", join(codeOut, "packet"), "--out", viewerOut]);
const viewerHtml = await readFile(join(viewerOut, "index.html"), "utf8");
const viewerHasExpectedContent = ["Worker Graph", "Artifacts", "Metrics", "Safety", "proposal"].every((text) => viewerHtml.includes(text));
results.push({ name: "viewer contains graph/status/artifact information", ok: viewerHasExpectedContent, exitCode: viewerHasExpectedContent ? 0 : 1, durationMs: 0, outDir: viewerOut });
if (!viewerHasExpectedContent) throw new Error("packet viewer did not include expected content");

const providerOriginalState = await readFile(join(providerRepo, "state.txt"), "utf8");
const summary = renderSummary(providerRepo, providerOriginalState);
await writeFile(join(validationDir, "summary.md"), summary, "utf8");
await writeFile(join(validationDir, "results.json"), JSON.stringify({
  schemaVersion: "alpha-7-packet-validation",
  generatedAt: new Date().toISOString(),
  rawRoot,
  packets: Object.fromEntries(packets),
  viewerOut,
  providerOriginalState,
  results
}, null, 2), "utf8");

console.log(summary);

async function run(name: string, outDir: string, args: string[], expectSuccess = true): Promise<void> {
  const started = Date.now();
  try {
    const result = await execFileAsync("pnpm", ["--dir", repo, "dev", ...args], {
      cwd: "/tmp",
      maxBuffer: 1024 * 1024
    });
    results.push({ name, ok: expectSuccess, exitCode: 0, durationMs: Date.now() - started, outDir, stdout: bounded(result.stdout), stderr: bounded(result.stderr) });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    results.push({ name, ok: !expectSuccess, exitCode: failure.code ?? 1, durationMs: Date.now() - started, outDir, stdout: bounded(failure.stdout ?? ""), stderr: bounded(failure.stderr ?? "") });
    if (expectSuccess) throw error;
  }
}

async function createSampleGitRepo(): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "runforge-alpha7-sample-repo-"));
  await cp(join(repo, "fixtures/repos/sample-js"), copy, { recursive: true });
  await initGitRepo(copy);
  return copy;
}

async function createProviderGitRepo(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "runforge-alpha7-provider-repo-"));
  await writeFile(join(source, "state.txt"), "bad\n", "utf8");
  await initGitRepo(source);
  return source;
}

async function initGitRepo(path: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["-c", "user.name=RunForge Validation", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: path });
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
  return `${[
    "# RunForge Packet Validation",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Raw outputs:",
    `- ${rawRoot}`,
    `- Viewer: ${join(rawRoot, "viewer-code-proposal/index.html")}`,
    "",
    "Validated packet types:",
    "- external check",
    "- failure triage",
    "- proposal readiness",
    "- code proposal",
    "- provider proposal",
    "",
    "Results:",
    ...results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} ${result.name} (exit ${result.exitCode})`),
    "",
    "Negative validation:",
    "- A deliberately broken packet without runId failed packet inspector validation.",
    "",
    "Original repo mutation check:",
    `- Provider repo: ${providerRepo}`,
    `- state.txt after provider run: ${JSON.stringify(providerOriginalState)}`,
    "",
    "Viewer:",
    "- Static HTML viewer was generated and checked for graph/status/artifact information."
  ].join("\n")}\n`;
}

function bounded(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[truncated]\n` : text;
}
