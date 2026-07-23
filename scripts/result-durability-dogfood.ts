import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startControlPlaneServer } from "../src/control-plane/server.js";

const exec = promisify(execFile);
const jsonHeaders = { "content-type": "application/json" };
const root = await mkdtemp(join(tmpdir(), "runforge-result-durability-dogfood-"));
const repo = join(root, "synthetic-infrastructure"); const stateRoot = join(root, "state");
await import("node:fs/promises").then(({ mkdir }) => mkdir(repo, { recursive: true }));
for (const name of ["infra-a.js", "infra-b.js", "infra-c.js", "infra-d.js"]) await writeFile(join(repo, name), "export const ready = false;\n");
await writeFile(join(repo, "verify.mjs"), `import { readFileSync } from "node:fs"; for (const name of ["infra-a.js","infra-b.js","infra-c.js","infra-d.js"]) if (!readFileSync(name,"utf8").includes("true")) process.exit(1); console.log("4/4 synthetic infrastructure files green");\n`);
await git(repo, ["init", "-b", "main"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=RunForge Dogfood", "-c", "user.email=runforge@localhost", "commit", "-m", "synthetic base"]);
const adapter = join(root, "synthetic-adapter.mjs");
await writeFile(adapter, `import { readFileSync, writeFileSync } from "node:fs"; for (const name of ["infra-a.js","infra-b.js","infra-c.js","infra-d.js"]) writeFileSync(name, readFileSync(name,"utf8").replace("false","true")); console.log("implemented exactly four scoped files"); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:119900,output_tokens:100}}));\n`);
const previousCommand = process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND, previousAccounting = process.env.RUNFORGE_USAGE_ACCOUNTING, previousCapabilities = process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES;
process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = `${process.execPath} ${adapter}`; process.env.RUNFORGE_USAGE_ACCOUNTING = "synthetic";
process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = JSON.stringify({ maxInputContextTokens: 200_000, maxOutputTokens: 200_000, maxReasoningTokens: 200_000, maxWallClockMs: 300_000, maxCallsPerPhase: 3, maxCostUsd: 10, guarantees: { inputTokens: true, outputTokens: true, reasoningTokens: true, wallClock: true, calls: true, cost: true } });
const server = await startControlPlaneServer({ port: 0, stateRoot });
try {
  const before = { head: await git(repo, ["rev-parse", "HEAD"]), status: await git(repo, ["status", "--porcelain=v1"]) };
  const capabilities = await fetch(`${server.url}/v1/capabilities`).then(json);
  const project = await fetch(`${server.url}/v1/projects/inspect`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ path: repo, register: true }) }).then(json);
  const request = structuredClone(capabilities.taskSpecContract.implementationRequest); request.projectId = project.project.id; request.taskSpec.taskId = "RUNFORGE-RESULT-DURABILITY-DOGFOOD-1";
  request.taskSpec.task = { text: "Set ready=true in exactly infra-a.js, infra-b.js, infra-c.js, and infra-d.js.", goal: "Four scoped synthetic infrastructure files validate green.", acceptanceCriteria: ["Exactly four files changed", "node verify.mjs is green", "target main is unchanged", "no publication"] };
  request.taskSpec.target.dirtyPolicy = "use_disposable_from_base_sha"; request.taskSpec.execution.maxRepairIterations = 1; request.taskSpec.execution.phaseBudgets.implementation = 1_000;
  request.taskSpec.discovery = { policy: "explicit", profile: "small-scope", explicitFiles: ["infra-a.js", "infra-b.js", "infra-c.js", "infra-d.js", "verify.mjs"], maxFiles: 6, maxBytes: 20000, maxTokens: 4000, stopCondition: "Stop after the four files and verifier are sufficient." };
  request.taskSpec.validation = { mode: "explicit", commands: ["node verify.mjs"] }; request.publication = "none";
  const createResponse = await fetch(`${server.url}/v1/tasks`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(request) }); if (createResponse.status !== 202) throw new Error(`create failed: ${JSON.stringify(await json(createResponse))}`);
  const acceptedTask = await json(createResponse); const terminal = await poll(`${server.url}/v1/tasks/${acceptedTask.id}`); const result = await fetch(`${server.url}/v1/tasks/${acceptedTask.id}/result`).then(json);
  if (!result.artifact || !Array.isArray(result.providerCalls)) throw new Error(`unexpected result shape: ${JSON.stringify({ keys: Object.keys(result), status: result.status, error: result.error, errors: result.errors, workflow: result.workflow })}`);
  const checkpointId = result.artifact.bestValidatedCheckpointId; const providerCallsBeforeAccept = result.providerCalls.length;
  const accepted = await fetch(`${server.url}/v1/tasks/${acceptedTask.id}/accept-completed-result`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ decisionId: "dogfood-accept-1", checkpointId, delivery: "patch" }) }).then(json);
  const after = { head: await git(repo, ["rev-parse", "HEAD"]), status: await git(repo, ["status", "--porcelain=v1"]) };
  const evidence = { schemaVersion: 1, taskId: acceptedTask.id, stateRoot, source: { before, after, mainUnchanged: before.head === after.head && before.status === after.status }, context: result.diagnostics.contextPlan, implementation: result.implementation, validation: result.validation, artifact: result.artifact, workflow: result.workflow, ownerGate: result.ownerGate, usage: result.usage, accept: { ...accepted, patch: accepted.patch ? `[portable patch ${Buffer.byteLength(accepted.patch)} bytes]` : null }, assertions: { fourFilesChanged: result.implementation.changedFiles.length === 4, validationGreen: result.validation.every((item: any) => item.exitCode === 0), overrunVisible: result.workflow.budgetExceeded === true, patchAvailable: result.artifact.status === "available" && typeof accepted.patch === "string", providerNotRerun: accepted.providerRerun === false && accepted.providerCalls === 0 && providerCallsBeforeAccept === result.providerCalls.length, publicationAbsent: result.publication.performed === false, sourceMainUnchanged: before.head === after.head } };
  if (!Object.values(evidence.assertions).every(Boolean)) throw new Error(`dogfood assertion failed: ${JSON.stringify(evidence.assertions)}`);
  if (process.env.RUNFORGE_DOGFOOD_OUT) await writeFile(process.env.RUNFORGE_DOGFOOD_OUT, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await server.close(); if (previousCommand === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND; else process.env.RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND = previousCommand; if (previousAccounting === undefined) delete process.env.RUNFORGE_USAGE_ACCOUNTING; else process.env.RUNFORGE_USAGE_ACCOUNTING = previousAccounting; if (previousCapabilities === undefined) delete process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES; else process.env.RUNFORGE_IMPLEMENTATION_PROVIDER_CAPABILITIES = previousCapabilities;
}

async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout; }
async function json(response: Response): Promise<any> {
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
async function poll(url: string): Promise<any> { for (let index = 0; index < 400; index += 1) { const task = await fetch(url).then(json); if (["completed", "failed", "awaiting_owner_decision", "interrupted"].includes(task.status)) return task; await new Promise((done) => setTimeout(done, 25)); } throw new Error("dogfood task did not finish"); }
