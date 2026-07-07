import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const rawRoot = "/tmp/runforge-alpha19-acceptance";
const milestoneRoot = join(rawRoot, "ALPHA-19");
const validationDir = join(repo, "validation/runs/ALPHA-19");
const errors: string[] = [];
const results: ScenarioResult[] = [];
const externalRepos: ExternalRepoRecord[] = [];
const packetPaths: string[] = [];
const viewerPaths: string[] = [];

interface ScenarioResult {
  id: string;
  description: string;
  command: string[];
  outDir?: string;
  ok: boolean;
  expectedSuccess: boolean;
  exitCode: number;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  checks: string[];
}

interface ExternalRepoRecord {
  id: string;
  path: string;
  available: boolean;
  beforeHead: string | null;
  afterHead: string | null;
  beforeStatus: string | null;
  afterStatus: string | null;
  unchanged: boolean;
}

await rm(rawRoot, { recursive: true, force: true });
await rm(validationDir, { recursive: true, force: true });
await mkdir(join(rawRoot, "fixtures"), { recursive: true });
await mkdir(milestoneRoot, { recursive: true });
await mkdir(validationDir, { recursive: true });

const fixtures = {
  setupPass: await createFixture("setup-pass"),
  setupFail: await createFixture("setup-fail"),
  setupDiagnostic: await createFixture("setup-diagnostic")
};

await runScenario("scenario-1-setup-pass", "setup passes and main passes", [
  "external", "check",
  "--repo", fixtures.setupPass,
  "--setup-command", "node setup.js",
  "--setup-network-intent", "none",
  "--command", "node verify.js",
  "--out", outPath("setup-pass"),
  "--run-id", "alpha19-setup-pass"
], true, async () => {
  const packet = packetPath("setup-pass");
  packetPaths.push(packet);
  await expectPacket(packet, { status: "passed", networkIntent: "none", commandsRun: 1, mutationVerdict: "unchanged" });
});

await runScenario("scenario-2-setup-fail", "setup fails and main commands are skipped", [
  "external", "check",
  "--repo", fixtures.setupFail,
  "--setup-command", "node setup-fail.js",
  "--setup-network-intent", "none",
  "--command", "node verify.js",
  "--out", outPath("setup-fail"),
  "--run-id", "alpha19-setup-fail"
], true, async () => {
  const packet = packetPath("setup-fail");
  packetPaths.push(packet);
  await expectPacket(packet, { status: "setup_failed", networkIntent: "none", commandsRun: 0, mutationVerdict: "unchanged" });
});

await runScenario("scenario-2-readiness-gated", "setup failure propagates through triage/readiness", [
  "external", "proposal-readiness",
  "--repo", fixtures.setupFail,
  "--setup-command", "node setup-fail.js",
  "--setup-network-intent", "none",
  "--command", "node verify.js",
  "--out", outPath("setup-fail-readiness"),
  "--run-id", "alpha19-setup-fail-readiness"
], true, async () => {
  const packet = packetPath("setup-fail-readiness");
  packetPaths.push(packet);
  const run = await readJson<{ status?: string; canAttemptCodeProposal?: boolean; failureCategory?: string }>(join(packet, "run.json"));
  check(run.status === "needs_more_context", "setup failure readiness should need more context");
  check(run.canAttemptCodeProposal === false, "setup failure readiness must block code proposal");
  check(run.failureCategory === "dependency_missing" || run.failureCategory === "environment_error", "setup failure should classify as setup/dependency/environment");
});

await runScenario("scenario-3-diagnostic", "setup fails and diagnostic main command fails", [
  "external", "check",
  "--repo", fixtures.setupDiagnostic,
  "--setup-command", "node setup-fail.js",
  "--setup-network-intent", "none",
  "--continue-after-setup-failure",
  "--command", "node verify-fail.js",
  "--out", outPath("setup-diagnostic"),
  "--run-id", "alpha19-setup-diagnostic"
], true, async () => {
  const packet = packetPath("setup-diagnostic");
  packetPaths.push(packet);
  await expectPacket(packet, { status: "setup_failed_main_failed", networkIntent: "none", commandsRun: 1, mutationVerdict: "unchanged" });
  const summary = await readFile(join(packet, "summary.md"), "utf8");
  check(summary.includes("do not treat this as a clean verification environment"), "diagnostic summary should warn against clean-environment interpretation");
});

await runScenario("scenario-4-network-expected", "setup network intent expected is recorded as audit-only", [
  "external", "check",
  "--repo", fixtures.setupPass,
  "--setup-command", "node setup.js",
  "--setup-network-intent", "expected",
  "--command", "node verify.js",
  "--out", outPath("setup-network-expected"),
  "--run-id", "alpha19-setup-network-expected"
], true, async () => {
  const packet = packetPath("setup-network-expected");
  packetPaths.push(packet);
  await expectPacket(packet, { status: "passed", networkIntent: "expected", commandsRun: 1, mutationVerdict: "unchanged" });
  const safety = await readJson<{ setupNetworkIntentEnforced?: boolean; setupPolicyNotes?: string[] }>(join(packet, "safety-report.json"));
  check(safety.setupNetworkIntentEnforced === false, "network intent should be audit-only");
  check((safety.setupPolicyNotes ?? []).join("\n").includes("does not enforce network blocking"), "safety report should explain network intent is not enforced");
});

await runScenario("scenario-5-invalid-intent", "invalid setup network intent fails clearly", [
  "external", "check",
  "--repo", fixtures.setupPass,
  "--setup-command", "node setup.js",
  "--setup-network-intent", "surprise",
  "--command", "node verify.js",
  "--out", outPath("invalid-network-intent")
], false, async (result) => {
  check(result.exitCode !== 0, "invalid network intent should exit non-zero");
  check(`${result.stderr ?? ""}${result.stdout ?? ""}`.includes("--setup-network-intent must be none, expected, or unknown"), "invalid network intent should print a clear error");
});

await runRealRepoScenario("scenario-6-factory", "/Users/evgeny/Documents/projects/factory", "factory");
await runRealRepoScenario("scenario-7-smartsql", "/Users/evgeny/Documents/projects/smartsql", "smartsql");

await runScenario("scenario-8-code-proposal-gated", "chained code-proposal with setup failure does not generate a patch", [
  "external", "code-proposal",
  "--repo", fixtures.setupFail,
  "--setup-command", "node setup-fail.js",
  "--setup-network-intent", "none",
  "--command", "node verify.js",
  "--out", outPath("chained-setup-fail"),
  "--run-id", "alpha19-chained-setup-fail"
], true, async () => {
  const packet = packetPath("chained-setup-fail");
  packetPaths.push(packet);
  const status = await readJson<{ outcome?: string; patchBytes?: number; reviewerDecision?: string }>(join(packet, "proposal-status.json"));
  check(status.outcome === "not_ready", "setup-fail code proposal should be not_ready");
  check(status.patchBytes === 0, "setup-fail code proposal should not generate patch bytes");
  check(status.reviewerDecision === "rejected_no_safe_proposal", "setup-fail code proposal should be rejected with no safe proposal");
});

const discoveredPackets = await findFiles(rawRoot, "run.json");
for (const runJson of discoveredPackets) {
  const packet = runJson.slice(0, -"run.json".length - 1);
  if (!packetPaths.includes(packet)) packetPaths.push(packet);
}

for (const packet of packetPaths) {
  await runScenario(`packet-validate-${scenarioName(packet)}`, `validate packet ${packet}`, [
    "packet", "inspect",
    "--packet", packet,
    "--validate"
  ], true);
  const viewerOut = join(rawRoot, "viewers", scenarioName(packet));
  await runScenario(`packet-view-${scenarioName(packet)}`, `render packet viewer ${packet}`, [
    "packet", "view",
    "--packet", packet,
    "--out", viewerOut
  ], true, async () => {
    await access(join(viewerOut, "index.html"));
    viewerPaths.push(join(viewerOut, "index.html"));
  });
}

await runScenario("packet-index", "build packet index and dashboard seed", [
  "packet", "index",
  "--root", rawRoot,
  "--out", join(rawRoot, "index"),
  "--dashboard-seed"
], true);

await runScenario("dashboard-build", "build setup-policy acceptance dashboard", [
  "dashboard", "build",
  "--seed", join(rawRoot, "index", "dashboard-seed.json"),
  "--out", join(rawRoot, "dashboard")
], true, async () => {
  const html = await readFile(join(rawRoot, "dashboard", "index.html"), "utf8");
  const data = await readJson<{ records?: Array<{ setupNetworkIntent?: string; setupDiagnosticMode?: string; tags?: string[] }> }>(join(rawRoot, "dashboard", "dashboard-data.json"));
  check(html.includes("Setup network"), "dashboard should expose setup network filter");
  check((data.records ?? []).some((record) => record.setupNetworkIntent === "expected"), "dashboard data should include setup network intent");
  check((data.records ?? []).some((record) => record.setupDiagnosticMode === "diagnostic-continue"), "dashboard data should include diagnostic setup mode");
});

for (const fixturePath of Object.values(fixtures)) {
  await assertRepoUnchanged(basename(fixturePath), fixturePath);
}

const finalPassed = errors.length === 0 && results.every((result) => result.ok);
const summary = renderSummary(finalPassed);
const json = {
  schemaVersion: "alpha-19-setup-policy-acceptance",
  generatedAt: new Date().toISOString(),
  rawRoot,
  externalRepos,
  packetPaths,
  viewerPaths,
  dashboard: {
    indexHtml: join(rawRoot, "dashboard", "index.html"),
    data: join(rawRoot, "dashboard", "dashboard-data.json")
  },
  scenarios: results,
  errors,
  finalVerdict: finalPassed ? "passed" : "failed"
};

await writeFile(join(validationDir, "summary.md"), summary, "utf8");
await writeFile(join(validationDir, "results.json"), `${JSON.stringify(json, null, 2)}\n`, "utf8");

console.log(summary);
if (!finalPassed) process.exitCode = 1;

async function runRealRepoScenario(id: string, path: string, label: string): Promise<void> {
  const before = await repoRecord(label, path, "before");
  if (!before.available) {
    externalRepos.push(before);
    results.push({
      id,
      description: `${label} external repo unavailable`,
      command: [],
      ok: true,
      expectedSuccess: true,
      exitCode: 0,
      durationMs: 0,
      checks: [`skipped: ${path} is unavailable`]
    });
    return;
  }
  externalRepos.push(before);
  await runScenario(id, `${label} safe external check`, [
    "external", "check",
    "--repo", path,
    "--setup-command", `node -e "console.log('${label} setup preflight')"`,
    "--setup-network-intent", "none",
    "--command", `node -e "console.log('${label} external check')"`,
    "--out", outPath(label),
    "--run-id", `alpha19-${label}`
  ], true, async () => {
    const packet = packetPath(label);
    packetPaths.push(packet);
    await expectPacket(packet, { status: "passed", networkIntent: "none", commandsRun: 1, mutationVerdict: "unchanged" });
    await assertRepoUnchanged(label, path);
  });
}

async function runScenario(
  id: string,
  description: string,
  args: string[],
  expectedSuccess: boolean,
  extraChecks?: (result: ScenarioResult) => Promise<void>
): Promise<void> {
  const started = Date.now();
  const command = ["pnpm", "--dir", repo, "dev", ...args];
  const scenarioErrorsBefore = errors.length;
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync("pnpm", ["--dir", repo, "dev", ...args], {
      cwd: "/tmp",
      maxBuffer: 1024 * 1024 * 8
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = failure.code ?? 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }
  const okExit = expectedSuccess ? exitCode === 0 : exitCode !== 0;
  if (!okExit) check(false, `${id} exit code ${exitCode}, expected ${expectedSuccess ? "success" : "failure"}`);
  const result: ScenarioResult = {
    id,
    description,
    command,
    outDir: outDirFor(args),
    ok: okExit,
    expectedSuccess,
    exitCode,
    durationMs: Date.now() - started,
    stdout: bounded(stdout),
    stderr: bounded(stderr),
    checks: []
  };
  if (extraChecks) await extraChecks(result);
  result.ok = result.ok && errors.length === scenarioErrorsBefore;
  if (errors.length > scenarioErrorsBefore) result.checks.push(...errors.slice(scenarioErrorsBefore));
  if (errors.length === scenarioErrorsBefore) result.checks.push("passed");
  results.push(result);
}

async function createFixture(name: string): Promise<string> {
  const dir = join(rawRoot, "fixtures", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: `runforge-alpha19-${name}`, private: true }, null, 2), "utf8");
  await writeFile(join(dir, "setup.js"), "console.log('setup ok');\n", "utf8");
  await writeFile(join(dir, "setup-fail.js"), "console.error('node_modules missing during setup preflight'); process.exit(1);\n", "utf8");
  await writeFile(join(dir, "verify.js"), "console.log('main ok');\n", "utf8");
  await writeFile(join(dir, "verify-fail.js"), "console.error('diagnostic main failed after setup failure'); process.exit(2);\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=RunForge Validation", "-c", "user.email=runforge@example.test", "commit", "-m", "fixture"], { cwd: dir });
  return dir;
}

async function expectPacket(packet: string, expected: { status: string; networkIntent: string; commandsRun: number; mutationVerdict: string }): Promise<void> {
  const run = await readJson<{
    status?: string;
    setupPolicy?: { networkIntent?: string };
    repo?: { mutationVerdict?: string };
  }>(join(packet, "run.json"));
  const metrics = await readJson<{ commandsRun?: number; setupPolicy?: { networkIntent?: string } }>(join(packet, "metrics.json"));
  const safety = await readJson<{ setupPolicy?: { networkIntent?: string }; originalRepoMutationVerdict?: string }>(join(packet, "safety-report.json"));
  check(run.status === expected.status, `${packet} status should be ${expected.status}, got ${run.status ?? "missing"}`);
  check(run.setupPolicy?.networkIntent === expected.networkIntent, `${packet} run.json should record setup network intent ${expected.networkIntent}`);
  check(metrics.setupPolicy?.networkIntent === expected.networkIntent, `${packet} metrics should record setup network intent ${expected.networkIntent}`);
  check(safety.setupPolicy?.networkIntent === expected.networkIntent, `${packet} safety report should record setup network intent ${expected.networkIntent}`);
  check(metrics.commandsRun === expected.commandsRun, `${packet} commandsRun should be ${expected.commandsRun}`);
  check(run.repo?.mutationVerdict === expected.mutationVerdict, `${packet} run mutation verdict should be ${expected.mutationVerdict}`);
  check(safety.originalRepoMutationVerdict === expected.mutationVerdict, `${packet} safety mutation verdict should be ${expected.mutationVerdict}`);
}

async function assertRepoUnchanged(id: string, path: string): Promise<void> {
  const before = externalRepos.find((record) => record.id === id && record.path === path) ?? await repoRecord(id, path, "before");
  const after = await repoRecord(id, path, "after");
  before.afterHead = after.afterHead;
  before.afterStatus = after.afterStatus;
  before.unchanged = before.beforeHead === after.afterHead && before.beforeStatus === after.afterStatus;
  check(before.unchanged, `${id} original repo should remain unchanged`);
}

async function repoRecord(id: string, path: string, phase: "before" | "after"): Promise<ExternalRepoRecord> {
  try {
    await access(path);
  } catch {
    return { id, path, available: false, beforeHead: null, afterHead: null, beforeStatus: null, afterStatus: null, unchanged: true };
  }
  const head = await gitOutput(path, ["rev-parse", "HEAD"]);
  const statusText = await gitOutput(path, ["status", "--short"]);
  return {
    id,
    path,
    available: true,
    beforeHead: phase === "before" ? head : null,
    afterHead: phase === "after" ? head : null,
    beforeStatus: phase === "before" ? statusText : null,
    afterStatus: phase === "after" ? statusText : null,
    unchanged: true
  };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, async (path) => {
    if (path.endsWith(`/${fileName}`)) found.push(path);
  });
  return found;
}

async function walk(path: string, visit: (path: string) => Promise<void>): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    await visit(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await walk(join(path, entry), visit);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function outDirFor(args: string[]): string | undefined {
  const index = args.indexOf("--out");
  return index >= 0 ? args[index + 1] : undefined;
}

function outPath(name: string): string {
  return join(milestoneRoot, name);
}

function packetPath(name: string): string {
  return join(outPath(name), "packet");
}

function scenarioName(packet: string): string {
  return packet.replace(rawRoot, "").replace(/^\//, "").replace(/\/packet$/, "").replace(/\//g, "__") || "root";
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function bounded(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[truncated]\n` : text;
}

function renderSummary(passed: boolean): string {
  const testedRepos = externalRepos.filter((record) => record.available);
  const unavailableRepos = externalRepos.filter((record) => !record.available);
  return `${[
    "# RunForge Alpha-19 Multi-Repo Setup Policy Acceptance",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Raw outputs: ${rawRoot}`,
    `Final verdict: ${passed ? "passed" : "failed"}`,
    "",
    "External repositories:",
    ...testedRepos.map((record) => `- ${record.id}: ${record.path}; before ${record.beforeHead ?? "unknown"} / ${JSON.stringify(record.beforeStatus ?? "")}; after ${record.afterHead ?? "unknown"} / ${JSON.stringify(record.afterStatus ?? "")}; unchanged ${record.unchanged}`),
    ...unavailableRepos.map((record) => `- ${record.id}: ${record.path}; unavailable, skipped`),
    "",
    "Scenarios:",
    ...results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} ${result.id}: ${result.description} (exit ${result.exitCode}, ${result.durationMs}ms)`),
    "",
    "Packets:",
    ...packetPaths.map((packet) => `- ${packet}`),
    "",
    "Viewers and dashboard:",
    ...viewerPaths.map((viewer) => `- ${viewer}`),
    `- ${join(rawRoot, "dashboard", "index.html")}`,
    "",
    "Findings and fixes:",
    "- Packet validation now checks setupPolicy shape on external command-check packet surfaces.",
    "- Packet viewers render setup policy and setup command results explicitly.",
    "- Dashboard seed/data includes setup network intent and diagnostic mode, with tags and a filter.",
    "",
    errors.length === 0 ? "Errors: none" : "Errors:",
    ...errors.map((error) => `- ${error}`)
  ].join("\n")}\n`;
}
