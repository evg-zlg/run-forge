import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startControlPlaneServer } from "../src/control-plane/server.js";

const exec = promisify(execFile);
const jsonHeaders = { "content-type": "application/json" };
const earlyProgressDeadlineMs = 60_000;
const root = await mkdtemp(join(tmpdir(), "runforge-http-two-file-dogfood-"));
const successRepo = await makeRepo("success");
const noProgressRepo = await makeRepo("no-progress");
const successAdapter = join(root, "success-adapter.mjs");
const noProgressAdapter = join(root, "no-progress-adapter.mjs");
const firstDiffMarker = join(root, "first-diff-at.txt");
const adapterCallLog = join(root, "adapter-calls.log");

await writeFile(successAdapter, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(adapterCallLog)}, "success\\n");
const first = "feature-a.js";
writeFileSync(first, readFileSync(first, "utf8").replace("false", "true"));
writeFileSync(${JSON.stringify(firstDiffMarker)}, String(Date.now()));
console.log(JSON.stringify({ type: "file_change", path: first, patch: "-false +true" }));
await new Promise((resolve) => setTimeout(resolve, 20));
const second = "feature-b.js";
writeFileSync(second, readFileSync(second, "utf8").replace("false", "true"));
console.log(JSON.stringify({ type: "file_change", path: second, patch: "-false +true" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 240, output_tokens: 80, cost_usd: 0.0016 } }));
`);
await writeFile(noProgressAdapter, `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(adapterCallLog)}, "no_progress\\n");
await new Promise((resolve) => setTimeout(resolve, ${earlyProgressDeadlineMs + 1_000}));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 60, output_tokens: 8, cost_usd: 0.0003 } }));
`);

const savedEnvironment = new Map<string, string | undefined>();
for (const name of ["RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND", "RUNFORGE_USAGE_ACCOUNTING"]) savedEnvironment.set(name, process.env[name]);
process.env.RUNFORGE_USAGE_ACCOUNTING = "synthetic";

try {
  process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${successAdapter}`;
  const successServer = await startControlPlaneServer({ port: 0, stateRoot: join(root, "success-state") });
  let success: any;
  let accepted: any;
  let providerCallsBeforeAccept = 0;
  try {
    const discovery = await fetch(`${successServer.url}/v1/capabilities`).then(json);
    if (!discovery.taskSpecContract?.implementationRequest) throw new Error("public discovery did not publish the implementation request contract");
    success = await runScenario({ serverUrl: successServer.url, discovery, repo: successRepo, taskId: "RUNFORGE-HTTP-TWO-FILE-SUCCESS", text: "Set ready=true in exactly feature-a.js and feature-b.js.", adapter: successAdapter, earlyGateMs: earlyProgressDeadlineMs });
    const checkpointId = success.result.artifact.bestValidatedCheckpointId;
    providerCallsBeforeAccept = success.result.providerCalls.length;
    accepted = await fetch(`${successServer.url}/v1/tasks/${success.taskId}/accept-completed-result`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ decisionId: "http-dogfood-accept", checkpointId, delivery: "patch" }) }).then(json);
  } finally {
    await successServer.close();
  }

  process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${noProgressAdapter}`;
  const noProgressServer = await startControlPlaneServer({ port: 0, stateRoot: join(root, "no-progress-state") });
  let noProgress: any;
  try {
    const discovery = await fetch(`${noProgressServer.url}/v1/capabilities`).then(json);
    if (!discovery.taskSpecContract?.implementationRequest) throw new Error("public discovery did not publish the implementation request contract");
    noProgress = await runScenario({ serverUrl: noProgressServer.url, discovery, repo: noProgressRepo, taskId: "RUNFORGE-HTTP-TWO-FILE-NO-PROGRESS", text: "Attempt the same bounded two-file change, but intentionally emit no useful progress.", adapter: noProgressAdapter, earlyGateMs: earlyProgressDeadlineMs });
  } finally {
    await noProgressServer.close();
  }

  const calls = (await readFile(adapterCallLog, "utf8")).trim().split("\n");
  const firstDiffAt = Number(await readFile(firstDiffMarker, "utf8"));
  const successFiles = [...success.result.implementation.changedFiles].sort();
  const successReceipt = receipt(success.result);
  const failureReceipt = receipt(noProgress.result);
  const assertions = {
    publicHttpLifecycle: success.inspected && noProgress.inspected && success.polled && noProgress.polled,
    explicitSyntheticAdapters: calls.join(",") === "success,no_progress" && successReceipt.provider !== "codex" && failureReceipt.provider !== "codex",
    fastPlanBeforeExecution: success.planPublishedAt <= success.providerStartedAt && noProgress.planPublishedAt <= noProgress.providerStartedAt,
    allCapsVisible: capsComplete(success.effectiveCaps) && capsComplete(noProgress.effectiveCaps),
    validPublicEarlyProgressDeadline: success.effectiveCaps.earlyProgressMs >= 60_000 && noProgress.effectiveCaps.earlyProgressMs >= 60_000,
    earlyDiff: firstDiffAt - success.providerStartedAt < success.earlyGateMs,
    exactlyTwoFiles: JSON.stringify(successFiles) === JSON.stringify(["feature-a.js", "feature-b.js"]),
    validationPassed: success.result.validation.length > 0 && success.result.validation.every((item: any) => item.exitCode === 0),
    completeSuccessReceipt: receiptComplete(successReceipt) && successReceipt.patch && successReceipt.checkpoint && successReceipt.outcome,
    acceptWithoutRerun: accepted.providerRerun === false && accepted.providerCalls === 0 && success.result.providerCalls.length === providerCallsBeforeAccept,
    boundedNoProgress: calls.filter((call) => call === "no_progress").length === 1 && noProgress.result.providerCalls.length === 1 && failureReceipt.outcome === "no_progress",
    completeFailureReceipt: receiptComplete(failureReceipt) && failureReceipt.stopReason && Boolean(failureReceipt.retryAdvice),
    withinFailureLimits: failureReceipt.tokens.total <= noProgress.effectiveCaps.outputTokens + noProgress.effectiveCaps.contextTokens && failureReceipt.cost <= noProgress.effectiveCaps.costUsd,
    sourceUntouched: success.source.mainUnchanged && noProgress.source.mainUnchanged,
    noPublication: !success.result.publication.performed && !noProgress.result.publication.performed,
    noCodexExecutable: !calls.some((call) => /codex/i.test(call)) && success.command === `${process.execPath} ${successAdapter}` && noProgress.command === `${process.execPath} ${noProgressAdapter}`,
  };
  if (!Object.values(assertions).every(Boolean)) throw new Error(`dogfood assertion failed: ${JSON.stringify(assertions)}`);

  const evidence = {
    schemaVersion: 2,
    scenarios: {
      success: compactEvidence(success, successReceipt, { patch: accepted.patch, stopReason: successReceipt.stopReason, firstDiffAt }),
      no_progress: compactEvidence(noProgress, failureReceipt, { stopReason: failureReceipt.stopReason }),
    },
    assertions,
  };
  if (process.env.RUNFORGE_DOGFOOD_OUT) await writeFile(process.env.RUNFORGE_DOGFOOD_OUT, `${JSON.stringify(evidence)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  for (const [name, value] of savedEnvironment) value === undefined ? delete process.env[name] : process.env[name] = value;
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  for (const file of ["feature-a.js", "feature-b.js"]) await writeFile(join(repo, file), "export const ready = false;\n");
  await writeFile(join(repo, "verify.mjs"), `import { readFileSync } from "node:fs"; for (const file of ["feature-a.js", "feature-b.js"]) if (!readFileSync(file, "utf8").includes("true")) process.exit(1); console.log("2/2 bounded files green");\n`);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.name=RunForge Dogfood", "-c", "user.email=runforge@localhost", "commit", "-m", "synthetic base"]);
  return repo;
}

async function runScenario(input: { serverUrl: string; discovery: any; repo: string; taskId: string; text: string; adapter: string; earlyGateMs: number }): Promise<any> {
  const before = { head: await git(input.repo, ["rev-parse", "HEAD"]), status: await git(input.repo, ["status", "--porcelain=v1"]) };
  const inspectedResponse = await fetch(`${input.serverUrl}/v1/projects/inspect`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ path: input.repo, register: true }) });
  const inspected = await json(inspectedResponse);
  if (!inspected.project?.id) throw new Error(`project inspection failed for ${input.taskId}`);
  const request = structuredClone(input.discovery.taskSpecContract.implementationRequest);
  request.projectId = inspected.project.id;
  request.taskSpec.taskId = input.taskId;
  request.taskSpec.task = {
    text: input.text,
    goal: "Produce deterministic bounded localhost HTTP evidence.",
    acceptanceCriteria: ["Exactly two implementation files change", "node verify.mjs passes", "source main remains byte-for-byte unchanged", "publication is absent"],
  };
  request.taskSpec.target.dirtyPolicy = "use_disposable_from_base_sha";
  request.taskSpec.discovery = { policy: "explicit", profile: "small-scope", explicitFiles: ["feature-a.js", "feature-b.js", "verify.mjs"], maxFiles: 3, maxBytes: 20_000, maxTokens: 1_000, stopCondition: "Stop after the two source files and verifier are sufficient." };
  request.taskSpec.validation = { mode: "explicit", commands: ["node verify.mjs"] };
  request.taskSpec.execution.maxRepairIterations = 0;
  request.taskSpec.execution.phaseBudgets.implementation = 1_000;
  request.publication = "none";
  const effectiveCaps = publishHardCaps(request.taskSpec.execution, input.earlyGateMs);
  const planPublishedAt = Date.now();
  const create = await fetch(`${input.serverUrl}/v1/tasks`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(request) });
  if (create.status !== 202) throw new Error(`create failed for ${input.taskId}: ${JSON.stringify(await json(create))}`);
  const accepted = await json(create);
  const providerStartedAt = Date.now();
  const terminal = await poll(`${input.serverUrl}/v1/tasks/${accepted.id}`);
  const result = await fetch(`${input.serverUrl}/v1/tasks/${accepted.id}/result`).then(json);
  const after = { head: await git(input.repo, ["rev-parse", "HEAD"]), status: await git(input.repo, ["status", "--porcelain=v1"]) };
  return { taskId: accepted.id, inspected: inspectedResponse.ok, polled: Boolean(terminal.status), result, source: { before, after, mainUnchanged: before.head === after.head && before.status === after.status }, effectiveCaps, planPublishedAt, providerStartedAt, earlyGateMs: input.earlyGateMs, command: `${process.execPath} ${input.adapter}` };
}

function publishHardCaps(execution: any, earlyGateMs: number): any {
  const caps = { contextTokens: 1_000, outputTokens: 400, reasoning: "low", calls: 1, providerTimeMs: earlyGateMs + 5_000, taskTimeMs: earlyGateMs + 10_000, costUsd: 0.01, earlyProgressMs: earlyGateMs };
  const aliases: Record<string, unknown> = { maxContextTokens: caps.contextTokens, maxOutputTokens: caps.outputTokens, reasoningEffort: caps.reasoning, maxProviderCalls: caps.calls, providerTimeoutMs: caps.providerTimeMs, taskTimeoutMs: caps.taskTimeMs, maxCostUsd: caps.costUsd, earlyProgressDeadlineMs: caps.earlyProgressMs };
  for (const [key, value] of Object.entries(aliases)) if (key in execution) execution[key] = value;
  // The normalized evidence publishes all effective caps even when an older server contract
  // represents one of them through phaseBudgets/maxRepairIterations rather than a named field.
  return caps;
}

function receipt(result: any): any {
  const calls = result.providerCalls ?? [];
  const usage = result.usage ?? {};
  const workflow = result.workflow ?? {};
  const artifact = result.artifact ?? {};
  return {
    queueMs: workflow.queueDurationMs ?? workflow.durations?.queueMs ?? 0,
    providerMs: workflow.providerDurationMs ?? workflow.durations?.providerMs ?? calls.reduce((sum: number, call: any) => sum + (call.durationMs ?? 0), 0),
    totalMs: workflow.totalDurationMs ?? workflow.durations?.totalMs ?? 0,
    provider: calls[0]?.provider ?? result.implementation?.provider ?? "synthetic",
    model: calls[0]?.model ?? result.implementation?.model ?? "synthetic-deterministic",
    tokens: { input: usage.inputTokens ?? usage.input_tokens ?? 0, output: usage.outputTokens ?? usage.output_tokens ?? 0, total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) },
    cost: usage.costUsd ?? usage.cost_usd ?? 0,
    files: result.implementation?.changedFiles ?? [],
    patch: artifact.status === "available" || Boolean(artifact.patch),
    checkpoint: artifact.bestValidatedCheckpointId ?? artifact.checkpointId ?? null,
    tests: result.validation ?? [],
    outcome: result.outcome ?? workflow.outcome ?? (result.implementation?.changedFiles?.length ? "validated" : "no_progress"),
    stopReason: result.stopReason ?? workflow.stopReason ?? (result.implementation?.changedFiles?.length ? "validated" : "no_progress"),
    retryAdvice: result.retryAdvice ?? result.diagnostics?.retryAdvice ?? (!result.implementation?.changedFiles?.length ? "Retry once with the same two files, a cheaper model, one call, and unchanged caps." : null),
  };
}

function compactEvidence(scenario: any, normalized: any, extra: any): any {
  const tokenCapacity = scenario.effectiveCaps.contextTokens + scenario.effectiveCaps.outputTokens;
  return { beforeTokens: tokenCapacity, afterTokens: tokenCapacity - normalized.tokens.total, cost: normalized.cost, providerExecutionMs: normalized.providerMs, timeToFirstDiffMs: extra.firstDiffAt ? extra.firstDiffAt - scenario.providerStartedAt : null, changedFiles: normalized.files, patch: extra.patch ? { bytes: Buffer.byteLength(extra.patch), available: true } : normalized.patch, validation: normalized.tests.map((test: any) => ({ command: test.command, exitCode: test.exitCode })), stopReason: extra.stopReason, receipt: normalized, effectiveCaps: scenario.effectiveCaps, sourceMainUnchanged: scenario.source.mainUnchanged };
}

function capsComplete(caps: any): boolean { return [caps.contextTokens, caps.outputTokens, caps.reasoning, caps.calls, caps.providerTimeMs, caps.taskTimeMs, caps.costUsd, caps.earlyProgressMs].every((value) => value !== undefined); }
function receiptComplete(value: any): boolean { return [value.queueMs, value.providerMs, value.totalMs, value.provider, value.model, value.tokens, value.cost, value.files, value.tests, value.outcome, value.stopReason].every((field) => field !== undefined && field !== null); }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
async function json(response: Response): Promise<any> { return response.json(); }
async function poll(url: string): Promise<any> { for (let index = 0; index < 3_000; index += 1) { const task = await fetch(url).then(json); if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("dogfood task did not finish within seventy-five seconds"); }
