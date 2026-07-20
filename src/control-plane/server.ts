import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactJson } from "../admin/redaction.js";
import { getRunForgeVersionInfo } from "../core/version.js";
import { implementationExecutorContract, publicTaskSpecContract, taskRuntimeIds, taskSpecSchemaPath, taskSpecV2Schema } from "../product/task-spec-contract.js";
import { commandVersion } from "../product/project-inspection.js";
import { ControlPlaneError, controlPlaneApiVersion, defaultControlPlaneHost, defaultControlPlanePort, defaultMaxRequestBytes, parseAcceptCompletedRequest, parseCheckpointRepairRequest, parseDecisionRequest, parseDiscardResultRequest, parseProjectRequest, parseTaskRequest } from "./contracts.js";
import { ControlPlaneManager, redactPublicValue } from "./manager.js";
import { ControlPlaneStore } from "./state.js";
import { discoverImplementationExecutors } from "../implementation/executor.js";
import {
  executionAgreementCapabilities,
  executionAgreementNegotiatePath,
  executionAgreementSchemaPath,
  parseExecutionAgreementNegotiationRequest,
  technicalCapabilitiesForExecutor,
} from "./execution-agreements.js";

export type ControlPlaneServerOptions = { host?: string; port?: number; stateRoot?: string; maxRequestBytes?: number; manager?: ControlPlaneManager };
export type ControlPlaneServerInstance = { server: Server; url: string; manager: ControlPlaneManager; stateRoot: string; close: () => Promise<void> };
const taskResultSchemaPath = "/schemas/task-result-v1.schema.json";

export async function startControlPlaneServer(options: ControlPlaneServerOptions = {}): Promise<ControlPlaneServerInstance> {
  const host = options.host ?? defaultControlPlaneHost;
  if (!isLoopbackHost(host)) throw new ControlPlaneError(403, "non_local_bind_refused", `The control plane only binds to localhost; refusing ${host}.`);
  const stateRoot = resolve(options.stateRoot ?? join(homedir(), ".runforge", "control-plane"));
  const store = options.manager?.store ?? new ControlPlaneStore(stateRoot); const manager = options.manager ?? new ControlPlaneManager(store); await manager.initialize();
  const server = createServer((request, response) => handleControlPlaneRequest(request, response, { host, manager, maxRequestBytes: options.maxRequestBytes ?? defaultMaxRequestBytes }).catch((error) => sendError(response, error)));
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(options.port ?? defaultControlPlanePort, host, () => { server.off("error", fail); ok(); }); });
  const address = server.address(); const port = typeof address === "object" && address ? address.port : options.port ?? defaultControlPlanePort; const url = `http://${host}:${port}`;
  await store.writeServiceInfo({ pid: process.pid, url, host, port, stateRoot, startedAt: new Date().toISOString(), apiVersion: controlPlaneApiVersion });
  return { server, url, manager, stateRoot, close: () => { manager.close(); return new Promise<void>((ok, fail) => server.close((error) => error ? fail(error) : ok())); } };
}

export async function handleControlPlaneRequest(request: IncomingMessage, response: ServerResponse, context: { host: string; manager: ControlPlaneManager; maxRequestBytes: number }): Promise<void> {
  enforceLocalRequest(request, context.host);
  const rawUrl = request.url ?? "/";
  if (rawUrl.length > 2048) throw new ControlPlaneError(414, "uri_too_long", "Request URI exceeds 2048 bytes.");
  const url = new URL(rawUrl, `http://${context.host}`); const path = url.pathname; const method = request.method ?? "GET";
  if (method === "OPTIONS") { response.writeHead(204, corsHeaders(context.host)); response.end(); return; }
  if (method === "GET" && path === "/healthz") return sendJson(response, 200, await context.manager.health());
  if (method === "GET" && path === "/readyz") return sendJson(response, 200, await context.manager.health());
  if (method === "GET" && path === "/.well-known/runforge") return sendJson(response, 200, await discoveryManifest(request, context.host));
  if (method === "GET" && path === "/v1/capabilities") return sendJson(response, 200, await capabilities(context.manager.store.root));
  if (method === "GET" && path === taskSpecSchemaPath) return sendJson(response, 200, taskSpecV2Schema);
  if (method === "GET" && path === executionAgreementSchemaPath) return sendJson(response, 200, await readSchema("execution-agreement-v1.schema.json"));
  if (method === "GET" && path === taskResultSchemaPath) return sendJson(response, 200, await readSchema("task-result-v1.schema.json"));
  if (method === "GET" && path === "/schemas/control-plane-v1.schema.json") return sendJson(response, 200, await readSchema("control-plane-v1.schema.json"));
  if (method === "POST" && path === executionAgreementNegotiatePath) return sendJson(response, 201, await context.manager.negotiateAgreement(parseExecutionAgreementNegotiationRequest(await readJson(request, context.maxRequestBytes))));
  const agreementMatch = path.match(/^\/v1\/execution-agreements\/(ea_v1_[a-f0-9]{24})$/);
  if (agreementMatch && method === "GET") return sendJson(response, 200, await context.manager.getAgreement(agreementMatch[1]!));
  if (agreementMatch) throw new ControlPlaneError(405, "method_not_allowed", "Method not allowed for this endpoint.");
  if (method === "POST" && path === "/v1/projects/inspect") return sendJson(response, 200, await context.manager.inspectProject(parseProjectRequest(await readJson(request, context.maxRequestBytes))));
  if (method === "GET" && path === "/v1/projects") return sendJson(response, 200, { projects: await context.manager.store.listProjects() });
  if (method === "POST" && path === "/v1/tasks") { const task = await context.manager.createTask(parseTaskRequest(await readJson(request, context.maxRequestBytes))); return sendJson(response, 202, publicTask(task)); }
  if (method === "GET" && path === "/v1/tasks") return sendJson(response, 200, { tasks: (await context.manager.store.listTasks()).map(publicTask) });
  const match = path.match(/^\/v1\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{2,79})(?:\/(result|agreement|owner-decisions|accept-completed-result|checkpoint-repairs|discard-result|continue|retry|cancel|publication-decisions))?$/);
  if (!match) throw new ControlPlaneError(404, "not_found", "Endpoint not found.");
  const [, taskId, operation] = match;
  if (method === "GET" && !operation) return sendJson(response, 200, publicTask(await context.manager.getTask(taskId!)));
  if (method === "GET" && operation === "result") return sendJson(response, 200, redactPublicValue(await context.manager.getResult(taskId!)));
  if (method === "GET" && operation === "agreement") return sendJson(response, 200, await context.manager.getTaskAgreement(taskId!));
  if (method === "POST" && operation === "owner-decisions") return sendJson(response, 200, await context.manager.ownerDecision(taskId!, parseDecisionRequest(await readJson(request, context.maxRequestBytes), "owner")));
  if (method === "POST" && operation === "accept-completed-result") return sendJson(response, 200, await context.manager.acceptCompletedResult(taskId!, parseAcceptCompletedRequest(await readJson(request, context.maxRequestBytes))));
  if (method === "POST" && operation === "checkpoint-repairs") return sendJson(response, 202, await context.manager.repairFromCheckpoint(taskId!, parseCheckpointRepairRequest(await readJson(request, context.maxRequestBytes))));
  if (method === "POST" && operation === "discard-result") return sendJson(response, 200, await context.manager.discardCompletedResult(taskId!, parseDiscardResultRequest(await readJson(request, context.maxRequestBytes))));
  if (method === "POST" && operation === "continue") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 202, publicTask(await context.manager.continueTask(taskId!))); }
  if (method === "POST" && operation === "retry") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 202, publicTask(await context.manager.retryTask(taskId!))); }
  if (method === "POST" && operation === "cancel") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 200, publicTask(await context.manager.cancelTask(taskId!))); }
  if (method === "POST" && operation === "publication-decisions") return sendJson(response, 200, await context.manager.publicationDecision(taskId!, parseDecisionRequest(await readJson(request, context.maxRequestBytes), "publication")));
  throw new ControlPlaneError(405, "method_not_allowed", "Method not allowed for this endpoint.");
}

export function isLoopbackHost(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }

async function discoveryManifest(request: IncomingMessage, host: string): Promise<Record<string, unknown>> {
  const version = getRunForgeVersionInfo();
  const [implementationExecutors, dockerVersion] = await Promise.all([discoverImplementationExecutors(), commandVersion("docker", ["--version"])]);
  const authority = request.headers.host && isLocalHostHeader(request.headers.host) ? request.headers.host : `${host}:${defaultControlPlanePort}`;
  return {
    product: "RunForge", discoveryVersion: 5, apiVersion: controlPlaneApiVersion, version, localOnly: true, baseUrl: `http://${authority}`,
    implementationExecutors: publicImplementationExecutors(implementationExecutors), taskSpecContract: publicTaskSpecContract(),
    executionAgreements: dynamicAgreementCapabilities(implementationExecutors, dockerVersion),
    checkpointRepair: { endpoint: "/v1/tasks/{id}/checkpoint-repairs", choices: ["grant_additional_budget", "retry_from_checkpoint"], requiresCheckpointDigest: true, digestDiscovery: "GET /v1/tasks/{id}/result -> artifact.checkpoints[].digest", legacySchemaV1: "verified-on-read", immutableLegacyArtifactsRewritten: false, newExecutionGeneration: true, patchFallbackPreserved: true },
    endpoints: { health: "/healthz", readiness: "/readyz", capabilities: "/v1/capabilities", taskSpecSchema: taskSpecSchemaPath, executionAgreementSchema: executionAgreementSchemaPath, resultSchema: taskResultSchemaPath, executionAgreementNegotiation: executionAgreementNegotiatePath, executionAgreement: "/v1/execution-agreements/{id}", projectInspection: "/v1/projects/inspect", tasks: "/v1/tasks", task: "/v1/tasks/{id}", taskAgreement: "/v1/tasks/{id}/agreement", result: "/v1/tasks/{id}/result", ownerDecisions: "/v1/tasks/{id}/owner-decisions", acceptCompletedResult: "/v1/tasks/{id}/accept-completed-result", checkpointRepairs: "/v1/tasks/{id}/checkpoint-repairs", discardResult: "/v1/tasks/{id}/discard-result", continuation: "/v1/tasks/{id}/continue", retry: "/v1/tasks/{id}/retry", cancellation: "/v1/tasks/{id}/cancel", publicationDecisions: "/v1/tasks/{id}/publication-decisions" },
    lifecycle: { poll: "GET /v1/tasks/{id}", heartbeatField: "progress.lastHeartbeatAt", executionIdentityField: "progress.executionId", attemptField: "progress.attempt", phaseValues: ["understand_task", "implement", "validate", "repair", "finalize"], stalledAfterMs: 15000, terminal: ["completed", "failed", "interrupted"], recoveryAvailabilityField: "recovery.retryAvailable", ownerGate: "awaiting_owner_decision" },
    bootstrap: "Inspect discovery and capabilities, register the project, copy the published implementationRequest, poll progress, and follow only advertised recovery actions."
  };
}
async function capabilities(_stateRoot: string): Promise<Record<string, unknown>> {
  const [implementationExecutors, dockerVersion] = await Promise.all([discoverImplementationExecutors(), commandVersion("docker", ["--version"])]);
  const implementationReady = implementationExecutors.some((item) => item.status === "ready");
  return {
    schemaVersion: 5, apiVersion: controlPlaneApiVersion, transports: ["localhost-http"], projectLocators: ["absolute-path", "registration-id"], taskModes: ["inspection", "implementation", "validation", "repair"],
    checkpointRepair: { endpoint: "/v1/tasks/{id}/checkpoint-repairs", choices: ["grant_additional_budget", "retry_from_checkpoint"], requiresCheckpointDigest: true, digestDiscovery: "GET /v1/tasks/{id}/result -> artifact.checkpoints[].digest", legacySchemaV1: "verified-on-read", immutableLegacyArtifactsRewritten: false, newExecutionGeneration: true, patchFallbackPreserved: true },
    implementationExecutors: publicImplementationExecutors(implementationExecutors), taskSpecContract: publicTaskSpecContract(),
    executionAgreements: dynamicAgreementCapabilities(implementationExecutors, dockerVersion),
    execution: { engine: "TaskSpec v2", timeout: { globalCapMs: implementationExecutorContract.maxLimits.timeoutMs, capSource: "implementationExecutorContract.maxLimits.timeoutMs", requestedAndEffectivePublishedAtAcceptance: true, watchdogPolicy: "deadline and stale heartbeat" }, durableCheckpoints: true, acceptCompletedResult: true, runtimes: taskRuntimeIds, runtimeSupport: { "local-disposable": { available: implementationReady, implementation: implementationReady, reason: implementationReady ? "The implementation executor is ready for local disposable workspaces." : "No ready implementation executor is available." }, docker: { available: dockerVersion !== null, implementation: false, version: dockerVersion, reason: dockerVersion === null ? "Docker CLI is unavailable." : "Docker CLI is present for supported non-implementation lanes; the implementation executor does not support Docker." } }, dependencyPreparation: ["required", "if-needed", "disabled", "reuse-existing"], persistentState: true, restartRecovery: true, heartbeat: true, watchdog: true, cancellation: true, executionGenerations: true, boundedCleanup: true, interruptedResult: true, journalSchemaVersion: 1, continuationSchemaVersion: 1 },
    authority: { semantics: "explicit upper bounds; implementation requires implementation/providerCalls/network/localBranch/localCommit", inspect: true, implementation: true, providerCalls: "required-for-local-coding-agent", network: "required-for-provider-transport", localBranch: "required-for-disposable-worktree", localCommit: "required-for-local-result", remotePush: "separate-publication-decision", draftPublication: "separate-publication-decision", merge: false, deploy: false },
    safety: { defaultBind: defaultControlPlaneHost, maxRequestBytes: defaultMaxRequestBytes, secretsInResponses: false, providerCallsByDefault: false, networkByDefault: false, sharedCheckoutMutation: false },
    schemas: { taskSpec: taskSpecSchemaPath, executionAgreement: executionAgreementSchemaPath, result: taskResultSchemaPath, controlPlane: "/schemas/control-plane-v1.schema.json" }
  };
}

function dynamicAgreementCapabilities(implementationExecutors: Awaited<ReturnType<typeof discoverImplementationExecutors>>, dockerVersion: string | null): Record<string, unknown> {
  const ready = implementationExecutors.some((item) => item.status === "ready");
  return executionAgreementCapabilities(technicalCapabilitiesForExecutor(ready), {
    implementationExecutorReady: ready,
    runtimes: { "local-disposable": { ready }, docker: { cliReady: dockerVersion !== null, implementationSupported: false, reason: dockerVersion === null ? "Docker CLI is unavailable." : "Docker is not supported by the implementation executor." } },
    providers: implementationExecutors.map((item) => ({
      executorId: item.id, providerReady: item.status === "ready", credentialReady: item.status === "ready",
      modelReady: item.status === "ready", model: item.model, modelSelection: item.model === null ? "provider_default" : "explicit",
      supportedModes: item.supports, runtimes: item.runtime, limits: item.maxLimits,
      providerTokenBudgetMaximum: item.maxLimits.providerTokens,
      reason: item.status === "ready" ? "Executor and its existing credential mechanism are ready." : "No implementation executor with a ready existing credential mechanism is available.",
    })),
  });
}

function publicImplementationExecutors(executors: Awaited<ReturnType<typeof discoverImplementationExecutors>>): Record<string, unknown>[] {
  return executors.map((item) => ({
    id: item.id, status: item.status, supports: item.supports, providerCalls: item.providerCalls, runtime: item.runtime,
    providerRequirements: item.providerRequirements, networkRequirements: item.networkRequirements, maxLimits: item.maxLimits,
    limitations: item.status === "ready" ? [] : ["Implementation executor or its existing credential mechanism is not ready."], model: item.model,
    credentialReady: item.status === "ready", credentialReason: item.status === "ready" ? "Existing credential mechanism is ready." : "Existing credential mechanism is not ready; no credential data is exposed.",
  }));
}

async function readSchema(name: string): Promise<Record<string, unknown>> {
  const candidates = [new URL(`../../schemas/${name}`, import.meta.url), new URL(`../../../schemas/${name}`, import.meta.url)];
  for (const candidate of candidates) {
    try { return JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new ControlPlaneError(500, "schema_unavailable", `Bundled schema is unavailable: ${name}.`);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const type = request.headers["content-type"] ?? ""; if (!String(type).toLowerCase().startsWith("application/json")) throw new ControlPlaneError(415, "content_type_required", "Use application/json.");
  const declared = Number(request.headers["content-length"] ?? 0); if (declared > limit) throw new ControlPlaneError(413, "payload_too_large", `Request body exceeds ${limit} bytes.`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new ControlPlaneError(413, "payload_too_large", `Request body exceeds ${limit} bytes.`); chunks.push(buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ControlPlaneError(400, "malformed_json", "Request body is not valid JSON."); }
}
async function assertEmptyOrObject(request: IncomingMessage, limit: number): Promise<void> { if (Number(request.headers["content-length"] ?? 0) === 0) return; const body = await readJson(request, limit); if (!body || typeof body !== "object" || Array.isArray(body)) throw new ControlPlaneError(400, "invalid_request", "Body must be an object."); }
function publicTask(task: Awaited<ReturnType<ControlPlaneManager["getTask"]>>): Record<string, unknown> { const repair = task.checkpointRepair; return { id: task.id, projectId: task.projectId, status: task.status, timeout: task.timeout, executionAgreement: task.executionAgreement, authority: task.authority, selection: task.selection, ownerGate: task.ownerGate, publicationGate: task.publicationGate, createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error, progress: task.progress, recovery: task.recovery, execution: task.execution, continuation: task.continuation, ...(repair ? { checkpointRepair: { schemaVersion: repair.schemaVersion, decisionId: repair.decisionId, checkpointId: repair.checkpointId, checkpointDigest: repair.checkpointDigest, baseSha: repair.baseSha, executionAgreementId: repair.executionAgreementId, choice: repair.choice, additionalProviderTokens: repair.additionalProviderTokens, repairIntent: repair.repairIntent, sourceExecutionId: repair.sourceExecutionId, repairExecutionId: repair.repairExecutionId } } : {}), events: task.events }; }
function enforceLocalRequest(request: IncomingMessage, host: string): void { const hostHeader = String(request.headers.host ?? ""); if (hostHeader && !isLocalHostHeader(hostHeader) && !hostHeader.startsWith(`${host}:`)) throw new ControlPlaneError(403, "non_local_host", "Host header must resolve to localhost."); const origin = request.headers.origin; if (origin) { let originHost = ""; try { originHost = new URL(origin).hostname; } catch { throw new ControlPlaneError(403, "invalid_origin", "Origin is invalid."); } if (!isLoopbackHost(originHost)) throw new ControlPlaneError(403, "non_local_origin", "Cross-origin requests are limited to localhost."); } }
function isLocalHostHeader(value: string): boolean { try { return isLoopbackHost(new URL(`http://${value}`).hostname); } catch { return false; } }
function corsHeaders(host: string): Record<string, string> { return { "access-control-allow-origin": `http://${host}`, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }; }
function sendJson(response: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(redactJson(value), null, 2) + "\n"; response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-runforge-local-only": "true" }); response.end(body); }
function sendError(response: ServerResponse, error: unknown): void { const known = error instanceof ControlPlaneError ? error : new ControlPlaneError(500, "internal_invariant_violation", "The control plane encountered an internal invariant violation."); sendJson(response, known.status, redactPublicValue({ schemaVersion: 1, error: { code: known.code, message: known.message, retryable: known.retryable, ...(known.taskId ? { taskId: known.taskId } : {}), details: known.details ?? {} } })); }
