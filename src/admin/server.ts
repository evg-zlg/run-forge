import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAdminUi } from "./builder.js";
import { diffAdminConfigs, loadConfigEditorPayload, saveAdminConfigDraft, validateAdminConfigDraft } from "./config-edit.js";
import { draftStatus } from "./config-status.js";
import { loadAdminConfig } from "./config.js";
import { redactJson } from "./redaction.js";

export interface AdminServerOptions {
  host?: string;
  port?: number;
  config?: string;
  out?: string;
  repoRoot?: string;
}

export interface AdminServerInstance {
  server: Server;
  url: string;
  configPath: string;
  outputPath: string;
}

export async function startAdminServer(options: AdminServerOptions): Promise<AdminServerInstance> {
  const host = options.host ?? "127.0.0.1";
  if (!isLocalHost(host)) throw new Error(`Admin server only supports localhost binds by default. Refusing host: ${host}`);
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const out = resolve(options.out ?? "/tmp/runforge-admin-ui");
  const loaded = await loadAdminConfig(options.config);
  await buildAdminUi({ config: loaded.path, out, repoRoot });
  const server = createServer((request, response) => {
    handleAdminRequest(request, response, { ...options, host, repoRoot, out, config: loaded.path }).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, url: `http://${host}:${port}/`, configPath: loaded.path, outputPath: join(out, "index.html") };
}

export async function handleAdminRequest(request: IncomingMessage, response: ServerResponse, options: Required<Pick<AdminServerOptions, "host" | "repoRoot" | "out">> & AdminServerOptions): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": `http://${options.host}`,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type"
    });
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${options.host}`);
  if (request.method === "GET" && url.pathname === "/api/admin/status") {
    sendJson(response, 200, {
      ok: true,
      localOnly: true,
      providerCalls: false,
      repoMutation: false,
      configPath: resolve(options.config ?? ".")
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/config") {
    sendJson(response, 200, await loadConfigEditorPayload(options.config, options.repoRoot));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/config/validate") {
    const body = await readJson(request);
    const validation = await validateAdminConfigDraft(body.draft ?? body, options.repoRoot);
    sendJson(response, validation.ok ? 200 : 422, {
      ...validation,
      normalized: redactJson(validation.normalized),
      status: await draftStatus(validation.normalized, options.repoRoot)
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/config/diff") {
    const body = await readJson(request);
    const loaded = await loadAdminConfig(options.config);
    const validation = await validateAdminConfigDraft(body.draft ?? body, options.repoRoot);
    sendJson(response, 200, {
      diagnostics: validation.diagnostics,
      diff: diffAdminConfigs(loaded.config, validation.normalized)
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/config/save") {
    const body = await readJson(request);
    const result = await saveAdminConfigDraft({ configPath: options.config ?? "", draft: body.draft ?? body, repoRoot: options.repoRoot });
    if (result.saved) await buildAdminUi({ config: result.configPath, out: options.out, repoRoot: options.repoRoot });
    sendJson(response, result.saved ? 200 : 422, result);
    return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(await readFile(join(options.out, "index.html"), "utf8"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin-data.json") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(await readFile(join(options.out, "admin-data.json"), "utf8"));
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(redactJson(value), null, 2)}\n`);
}
