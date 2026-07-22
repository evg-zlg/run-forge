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
console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 60, output_tokens: 8, reasoning_tokens: 4, cost_usd: 0.0003 } }));
await new Promise((resolve) => setTimeout(resolve, ${earlyProgressDeadlineMs + 1_000}));
`);

const savedEnvironment = new Map<string, string | undefined>();
for (const name of ["RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND", "RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES", "RUNFORGE_USAGE_ACCOUNTING"]) savedEnvironment.set(name, process.env[name]);
process.env.RUNFORGE_USAGE_ACCOUNTING = "synthetic";
process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = JSON.stringify({
  maxInputContextTokens: 1_000, maxOutputTokens: 400, maxReasoningTokens: 100,
  maxWallClockMs: 65_000, maxCallsPerPhase: 1, maxCostUsd: 0.01,
  guarantees: { inputTokens: true, outputTokens: true, reasoningTokens: true, wallClock: true, calls: true, cost: true },
});

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
  const successReceipt = success.result.receipt;
  const failureReceipt = noProgress.result.receipt;
  const receiptKeys = ["queueDuration", "providerExecutionDuration", "totalDuration", "provider", "model", "phase", "calls", "inputTokens", "cachedTokens", "outputTokens", "reasoningTokens", "billedTokens", "cost", "availability", "filesRead", "filesChanged", "patchAvailable", "checkpointId", "testsStarted", "testsCompleted", "outcome", "stopReason", "failureClassification", "lastCompletedStage", "nextSafeAction"].sort();
  const assertions = {
    publicHttpLifecycle: success.inspected && noProgress.inspected && success.polled && noProgress.polled,
    explicitSyntheticAdapters: calls.join(",") === "success,no_progress" && successReceipt.provider !== "codex" && failureReceipt.provider !== "codex",
    fastPlanBeforeExecution: success.planPublishedAt <= success.providerStartedAt && noProgress.planPublishedAt <= noProgress.providerStartedAt && success.planOmittedFromRequest && noProgress.planOmittedFromRequest && success.requestedProfile === "fast" && noProgress.requestedProfile === "fast" && success.contextProfile === "small-scope" && noProgress.contextProfile === "small-scope" && [success, noProgress].every((scenario) => scenario.result.providerCalls[0].executionEnvelope.profile === "fast" && scenario.result.providerCalls[0].executionEnvelope.classification === "bounded-small"),
    allCapsVisible: capsComplete(success.effectiveCaps) && capsComplete(noProgress.effectiveCaps) && [success, noProgress].every((scenario) => { const total = Object.values(scenario.phaseBudgets).reduce((sum: number, value: any) => sum + value, 0); return Object.keys(scenario.phaseBudgets).length === 7 && total === 1_400 && total <= scenario.effectiveCaps.taskTokens && total <= scenario.effectiveCaps.providerTokens; }),
    validPublicEarlyProgressDeadline: success.effectiveCaps.earlyProgressMs >= 60_000 && noProgress.effectiveCaps.earlyProgressMs >= 60_000,
    earlyDiff: firstDiffAt - success.providerStartedAt < success.earlyGateMs,
    earlyPatchCheckpoint: success.result.artifact.checkpoints.some((checkpoint: any) => String(checkpoint.id).includes("stream")),
    enforcedEnvelopePublished: [success, noProgress].every((scenario) => {
      const limits = scenario.result.providerCalls[0].executionEnvelope.limits;
      return limits.maxInputContextTokens === scenario.effectiveCaps.contextTokens && limits.maxOutputTokens === scenario.effectiveCaps.outputTokens && limits.maxReasoningTokens === scenario.effectiveCaps.reasoningTokens && limits.maxCallsPerPhase === scenario.effectiveCaps.calls && limits.maxPhaseTokens === scenario.effectiveCaps.phaseTokens && limits.maxTaskTokens === scenario.effectiveCaps.taskTokens && limits.maxCostUsd === scenario.effectiveCaps.costUsd && limits.earlyProgressDeadlineMs === scenario.effectiveCaps.earlyProgressMs;
    }),
    exactlyTwoFiles: JSON.stringify(successFiles) === JSON.stringify(["feature-a.js", "feature-b.js"]),
    validationPassed: success.result.validation.length > 0 && success.result.validation.every((item: any) => item.exitCode === 0),
    completeSuccessReceipt: JSON.stringify(Object.keys(successReceipt).sort()) === JSON.stringify(receiptKeys) && successReceipt.patchAvailable && successReceipt.checkpointId && successReceipt.outcome === "completed" && successReceipt.totalDuration >= successReceipt.queueDuration + successReceipt.providerExecutionDuration,
    acceptWithoutRerun: accepted.providerRerun === false && accepted.providerCalls === 0 && providerCallsBeforeAccept === 1 && success.result.providerCalls.length === providerCallsBeforeAccept,
    boundedNoProgress: calls.filter((call) => call === "no_progress").length === 1 && noProgress.result.providerCalls.length === 1 && failureReceipt.calls === 1 && failureReceipt.outcome === "no_progress" && noProgress.result.diagnostics.retryPlan.automatic === false,
    completeFailureReceipt: JSON.stringify(Object.keys(failureReceipt).sort()) === JSON.stringify(receiptKeys) && failureReceipt.stopReason === "no_progress" && failureReceipt.totalDuration >= failureReceipt.queueDuration + failureReceipt.providerExecutionDuration,
    withinFailureLimits: failureReceipt.billedTokens <= noProgress.effectiveCaps.taskTokens && failureReceipt.inputTokens <= noProgress.effectiveCaps.contextTokens && failureReceipt.outputTokens <= noProgress.effectiveCaps.outputTokens && failureReceipt.reasoningTokens <= noProgress.effectiveCaps.reasoningTokens && failureReceipt.cost <= noProgress.effectiveCaps.costUsd,
    taskSpecGateKilledFailure: failureReceipt.providerExecutionDuration >= earlyProgressDeadlineMs && failureReceipt.providerExecutionDuration < noProgress.effectiveCaps.providerTimeMs && noProgress.result.providerCalls[0].executionEnvelope.limits.earlyProgressDeadlineMs === earlyProgressDeadlineMs,
    sourceUntouched: success.source.mainUnchanged && noProgress.source.mainUnchanged,
    noPublication: [success, noProgress].every((scenario) => scenario.result.publication.performed === false && scenario.result.safetyAssertions.targetMainPush === false && scenario.result.safetyAssertions.targetPrMerge === false && scenario.result.safetyAssertions.merge === false && scenario.result.safetyAssertions.publicationPerformed === false && scenario.requestedPublication === "none" && scenario.requestedMergePolicy === "never" && scenario.source.before.head === scenario.source.after.head && scenario.source.before.status === scenario.source.after.status) && accepted.delivery === "patch" && accepted.providerRerun === false && accepted.providerCalls === 0 && success.result.providerCalls.length === providerCallsBeforeAccept,
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
  const phaseBudgets = Object.fromEntries(Object.keys(request.taskSpec.execution.phaseBudgets).map((phase) => [phase, 0]));
  Object.assign(phaseBudgets, { implementation: 1_000, validation: 400 });
  Object.assign(request.taskSpec.execution, {
    requestedProfile: "fast",
    budgetMode: "hard", maxInputContextTokens: 1_000,
    maxOutputTokens: 400, maxReasoningTokens: 100, reasoningSetting: "low",
    maxCallsPerPhase: 1, maxPhaseTokens: 1_000, maxTaskTokens: 1_800,
    maxProviderTokens: 1_800, timeoutMs: 70_000,
    earlyProgressDeadlineMs, maxCostUsd: 0.01, maxRepairIterations: 0,
    phaseBudgets,
  });
  request.publication = "none";
  const effectiveCaps = publishHardCaps(request.taskSpec.execution, input.earlyGateMs);
  const planOmittedFromRequest = !("plan" in request.taskSpec.execution);
  const planPublishedAt = Date.now();
  const create = await fetch(`${input.serverUrl}/v1/tasks`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(request) });
  if (create.status !== 202) throw new Error(`create failed for ${input.taskId}: ${JSON.stringify(await json(create))}`);
  const accepted = await json(create);
  const providerStartedAt = Date.now();
  const terminal = await poll(`${input.serverUrl}/v1/tasks/${accepted.id}`);
  const result = await fetch(`${input.serverUrl}/v1/tasks/${accepted.id}/result`).then(json);
  const after = { head: await git(input.repo, ["rev-parse", "HEAD"]), status: await git(input.repo, ["status", "--porcelain=v1"]) };
  return { taskId: accepted.id, inspected: inspectedResponse.ok, polled: Boolean(terminal.status), result, source: { before, after, mainUnchanged: before.head === after.head && before.status === after.status }, effectiveCaps, phaseBudgets, planOmittedFromRequest, planPublishedAt, providerStartedAt, earlyGateMs: input.earlyGateMs, requestedProfile: request.taskSpec.execution.requestedProfile, contextProfile: request.taskSpec.discovery.profile, requestedPublication: request.publication, requestedMergePolicy: request.taskSpec.merge.policy, command: `${process.execPath} ${input.adapter}` };
}

function publishHardCaps(execution: any, earlyGateMs: number): any {
  return { contextTokens: execution.maxInputContextTokens, outputTokens: execution.maxOutputTokens, reasoningTokens: execution.maxReasoningTokens, reasoning: execution.reasoningSetting, calls: execution.maxCallsPerPhase, phaseTokens: execution.maxPhaseTokens, taskTokens: execution.maxTaskTokens, providerTokens: execution.maxProviderTokens, providerTimeMs: earlyGateMs + 5_000, taskTimeMs: execution.timeoutMs, costUsd: execution.maxCostUsd, earlyProgressMs: execution.earlyProgressDeadlineMs };
}

function compactEvidence(scenario: any, normalized: any, extra: any): any {
  return { beforeTokens: scenario.effectiveCaps.taskTokens, afterTokens: scenario.effectiveCaps.taskTokens - normalized.billedTokens, cost: normalized.cost, providerExecutionMs: normalized.providerExecutionDuration, timeToFirstDiffMs: extra.firstDiffAt ? extra.firstDiffAt - scenario.providerStartedAt : null, changedFiles: normalized.filesChanged, patch: extra.patch ? { bytes: Buffer.byteLength(extra.patch), available: true } : normalized.patchAvailable, validation: scenario.result.validation.map((test: any) => ({ command: test.command, exitCode: test.exitCode })), stopReason: extra.stopReason, receipt: normalized, effectiveCaps: scenario.effectiveCaps, sourceMainUnchanged: scenario.source.mainUnchanged };
}

function capsComplete(caps: any): boolean { return [caps.contextTokens, caps.outputTokens, caps.reasoningTokens, caps.reasoning, caps.calls, caps.phaseTokens, caps.taskTokens, caps.providerTokens, caps.providerTimeMs, caps.taskTimeMs, caps.costUsd, caps.earlyProgressMs].every((value) => value !== undefined); }
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
async function json(response: Response): Promise<any> { return response.json(); }
async function poll(url: string): Promise<any> { for (let index = 0; index < 3_000; index += 1) { const task = await fetch(url).then(json); if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("dogfood task did not finish within seventy-five seconds"); }
