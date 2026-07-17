import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redactJson } from "../admin/redaction.js";
import { getRunForgeVersionInfo, runForgeRoot } from "../core/version.js";
import { ControlPlaneError, controlPlaneApiVersion, defaultControlPlaneHost, defaultControlPlanePort, defaultMaxRequestBytes, parseDecisionRequest, parseProjectRequest, parseTaskRequest } from "./contracts.js";
import { ControlPlaneManager } from "./manager.js";
import { ControlPlaneStore } from "./state.js";
import { discoverImplementationExecutors } from "../implementation/executor.js";

export type ControlPlaneServerOptions = { host?: string; port?: number; stateRoot?: string; maxRequestBytes?: number; manager?: ControlPlaneManager };
export type ControlPlaneServerInstance = { server: Server; url: string; manager: ControlPlaneManager; stateRoot: string; close: () => Promise<void> };

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
  if (method === "GET" && path === "/schemas/task-spec-v2.schema.json") return sendJson(response, 200, await taskSpecSchema());
  if (method === "POST" && path === "/v1/projects/inspect") return sendJson(response, 200, await context.manager.inspectProject(parseProjectRequest(await readJson(request, context.maxRequestBytes))));
  if (method === "GET" && path === "/v1/projects") return sendJson(response, 200, { projects: await context.manager.store.listProjects() });
  if (method === "POST" && path === "/v1/tasks") { const task = await context.manager.createTask(parseTaskRequest(await readJson(request, context.maxRequestBytes))); return sendJson(response, 202, publicTask(task)); }
  if (method === "GET" && path === "/v1/tasks") return sendJson(response, 200, { tasks: (await context.manager.store.listTasks()).map(publicTask) });
  const match = path.match(/^\/v1\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{2,79})(?:\/(result|owner-decisions|continue|retry|cancel|publication-decisions))?$/);
  if (!match) throw new ControlPlaneError(404, "not_found", "Endpoint not found.");
  const [, taskId, operation] = match;
  if (method === "GET" && !operation) return sendJson(response, 200, publicTask(await context.manager.getTask(taskId!)));
  if (method === "GET" && operation === "result") return sendJson(response, 200, await context.manager.getResult(taskId!));
  if (method === "POST" && operation === "owner-decisions") return sendJson(response, 200, await context.manager.ownerDecision(taskId!, parseDecisionRequest(await readJson(request, context.maxRequestBytes), "owner")));
  if (method === "POST" && operation === "continue") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 202, publicTask(await context.manager.continueTask(taskId!))); }
  if (method === "POST" && operation === "retry") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 202, publicTask(await context.manager.retryTask(taskId!))); }
  if (method === "POST" && operation === "cancel") { await assertEmptyOrObject(request, context.maxRequestBytes); return sendJson(response, 200, publicTask(await context.manager.cancelTask(taskId!))); }
  if (method === "POST" && operation === "publication-decisions") return sendJson(response, 200, await context.manager.publicationDecision(taskId!, parseDecisionRequest(await readJson(request, context.maxRequestBytes), "publication")));
  throw new ControlPlaneError(405, "method_not_allowed", "Method not allowed for this endpoint.");
}

export function isLoopbackHost(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }

async function discoveryManifest(request: IncomingMessage, host: string): Promise<Record<string, unknown>> {
  const version = getRunForgeVersionInfo();
  const authority = request.headers.host && isLocalHostHeader(request.headers.host) ? request.headers.host : `${host}:${defaultControlPlanePort}`;
  return {
    product: "RunForge", discoveryVersion: 4, apiVersion: controlPlaneApiVersion, version, localOnly: true, baseUrl: `http://${authority}`,
    implementationExecutors: await discoverImplementationExecutors(), taskSpecContract: await publicTaskSpecContract(),
    endpoints: { health: "/healthz", readiness: "/readyz", capabilities: "/v1/capabilities", taskSpecSchema: "/schemas/task-spec-v2.schema.json", projectInspection: "/v1/projects/inspect", tasks: "/v1/tasks", task: "/v1/tasks/{id}", result: "/v1/tasks/{id}/result", ownerDecisions: "/v1/tasks/{id}/owner-decisions", continuation: "/v1/tasks/{id}/continue", retry: "/v1/tasks/{id}/retry", cancellation: "/v1/tasks/{id}/cancel", publicationDecisions: "/v1/tasks/{id}/publication-decisions" },
    lifecycle: { poll: "GET /v1/tasks/{id}", heartbeatField: "progress.lastHeartbeatAt", executionIdentityField: "progress.executionId", attemptField: "progress.attempt", phaseValues: ["understand_task", "implement", "validate", "repair", "finalize"], stalledAfterMs: 15000, terminal: ["completed", "failed", "interrupted"], recoveryAvailabilityField: "recovery.retryAvailable", ownerGate: "awaiting_owner_decision" },
    bootstrap: "Inspect discovery and capabilities, register the project, copy the published implementationRequest, poll progress, and follow only advertised recovery actions."
  };
}
async function capabilities(_stateRoot: string): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 4, apiVersion: controlPlaneApiVersion, transports: ["localhost-http"], projectLocators: ["absolute-path", "registration-id"], taskModes: ["inspection", "implementation", "validation", "repair"],
    implementationExecutors: await discoverImplementationExecutors(), taskSpecContract: await publicTaskSpecContract(),
    execution: { engine: "TaskSpec v2", runtimes: ["docker", "local-disposable"], dependencyPreparation: ["required", "if-needed", "disabled", "reuse-existing"], persistentState: true, restartRecovery: true, heartbeat: true, watchdog: true, cancellation: true, executionGenerations: true, boundedCleanup: true, interruptedResult: true, journalSchemaVersion: 1, continuationSchemaVersion: 1 },
    authority: { semantics: "explicit upper bounds; implementation requires implementation/providerCalls/network/localBranch/localCommit", inspect: true, implementation: true, providerCalls: "required-for-local-coding-agent", network: "required-for-provider-transport", localBranch: "required-for-disposable-worktree", localCommit: "required-for-local-result", remotePush: "separate-publication-decision", draftPublication: "separate-publication-decision", merge: false, deploy: false },
    safety: { defaultBind: defaultControlPlaneHost, maxRequestBytes: defaultMaxRequestBytes, secretsInResponses: false, providerCallsByDefault: false, networkByDefault: false, sharedCheckoutMutation: false },
    schemas: { taskSpec: "/schemas/task-spec-v2.schema.json", result: "schemas/task-result-v1.schema.json", controlPlane: "schemas/control-plane-v1.schema.json" }
  };
}

async function taskSpecSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(runForgeRoot(), "schemas", "task-spec-v2.schema.json"), "utf8")) as Record<string, unknown>;
}

async function publicTaskSpecContract(): Promise<Record<string, unknown>> {
  return {
    contractVersion: "task-spec-v2", schemaVersion: 2, schemaUrl: "/schemas/task-spec-v2.schema.json", schema: await taskSpecSchema(),
    executionModes: ["inspection", "implementation", "validation", "repair"], implementationExecutorIds: ["local-coding-agent"], compatibleRuntimes: { "local-coding-agent": ["local-disposable"] },
    requiredImplementationAuthority: { taskSpec: ["authority.profile=bounded-implementation", "authority.allowProviderCalls=true", "authority.allowNetwork=true"], request: ["implementation=true", "providerCalls=true", "network=true", "localBranch=true", "localCommit=true"], publication: ["publication=none", "remotePush=false", "draftPublication=false", "merge=false", "deploy=false"] },
    implementationRequest: { projectId: "<registered-project-id>", taskSpec: { schemaVersion: 2, taskId: "IMPLEMENTATION-TASK-1", task: { text: "Fix the bounded defect and add a regression test.", goal: "Validation is green and a local commit is recorded.", acceptanceCriteria: ["Defect is fixed", "Regression test passes", "Local commit is recorded"] }, execution: { mode: "implementation", maxRepairIterations: 2, timeoutMs: 300000, maxChangedFiles: 20, maxPatchBytes: 500000, maxProviderTokens: 100000 }, runtime: { preference: "local", dependencyPreparation: "if-needed", externalNetwork: "allowed" }, validation: { mode: "auto", commands: [] }, authority: { profile: "bounded-implementation", forbiddenAreas: [".env", "secrets"], allowProviderCalls: true, allowNetwork: true }, git: { publication: "none", branch: null }, merge: { policy: "never" }, deploy: { policy: "never" }, repair: { mode: "none", plan: null } }, authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false }, publication: "none" }
  };
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
function publicTask(task: Awaited<ReturnType<ControlPlaneManager["getTask"]>>): Record<string, unknown> { return { id: task.id, projectId: task.projectId, status: task.status, authority: task.authority, selection: task.selection, ownerGate: task.ownerGate, publicationGate: task.publicationGate, createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error, progress: task.progress, recovery: task.recovery, execution: task.execution, continuation: task.continuation, events: task.events }; }
function enforceLocalRequest(request: IncomingMessage, host: string): void { const hostHeader = String(request.headers.host ?? ""); if (hostHeader && !isLocalHostHeader(hostHeader) && !hostHeader.startsWith(`${host}:`)) throw new ControlPlaneError(403, "non_local_host", "Host header must resolve to localhost."); const origin = request.headers.origin; if (origin) { let originHost = ""; try { originHost = new URL(origin).hostname; } catch { throw new ControlPlaneError(403, "invalid_origin", "Origin is invalid."); } if (!isLoopbackHost(originHost)) throw new ControlPlaneError(403, "non_local_origin", "Cross-origin requests are limited to localhost."); } }
function isLocalHostHeader(value: string): boolean { try { return isLoopbackHost(new URL(`http://${value}`).hostname); } catch { return false; } }
function corsHeaders(host: string): Record<string, string> { return { "access-control-allow-origin": `http://${host}`, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }; }
function sendJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-runforge-local-only": "true" }); response.end(JSON.stringify(redactJson(value), null, 2) + "\n"); }
function sendError(response: ServerResponse, error: unknown): void { const known = error instanceof ControlPlaneError ? error : new ControlPlaneError(500, "internal_invariant_violation", "The control plane encountered an internal invariant violation."); sendJson(response, known.status, { schemaVersion: 1, error: { code: known.code, message: known.message, retryable: known.retryable, ...(known.taskId ? { taskId: known.taskId } : {}), details: known.details ?? {} } }); }
