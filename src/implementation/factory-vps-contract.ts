import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Protocol shared by the local control plane and the VPS-only Factory bridge.
 * It deliberately contains policy and evidence only: provider credentials are
 * never a member of this contract.
 */
export const factoryVpsProtocolVersion = "runforge-factory-vps/v1" as const;
/** Stable public executor ID; distinct from the remote SSH bridge command. */
export const factoryVpsExecutorId = "runforge-factory-vps" as const;
export const defaultFactoryVpsArtifactLimit = 25_000_000;
export const forbiddenRemoteSourcePath = /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|secrets?|credentials?)(?:\/|$)|\.(?:pem|key|p12)$/i;

export type FactoryVpsCapability = {
  protocolVersion: typeof factoryVpsProtocolVersion;
  executorId: typeof factoryVpsExecutorId;
  runtime: { version: string; revision: string | null };
  health: "ready" | "degraded" | "unavailable";
  taskModes: string[];
  providers: Array<{ id: string; models: string[]; credentialReady: boolean }>;
  runtimes: string[];
  limits: { timeoutMs: number; providerTokens: number; artifactBytes: number };
  networkPolicy: "allowlisted" | "isolated" | "denied";
  cancellation: boolean;
  heartbeatIntervalMs: number;
  recovery: boolean;
  usageTelemetry: boolean;
};

export type FactoryVpsSourceManifest = {
  mode: "git-sha" | "content-addressed-bundle" | "patch-checkpoint" | "artifact-validation";
  repository: string;
  baseSha: string;
  paths: Array<{ path: string; bytes: number; sha256: string }>;
  bytes: number;
  digest: string;
  cleanup: "remote-ephemeral";
};

export type FactoryVpsEnvelope = {
  protocolVersion: typeof factoryVpsProtocolVersion;
  taskId: string;
  attempt: number;
  generation: string;
  nonce: string;
  issuedAt: string;
  deadlineAt: string;
  source: FactoryVpsSourceManifest;
  taskSpec: Record<string, unknown>;
  executionAgreement: Record<string, unknown>;
  providerPolicy: Record<string, unknown>;
  authority: Record<string, unknown>;
  validation: Record<string, unknown>;
  artifactManifest: { maxBytes: number; requireRedaction: true; requireSha256: true };
};

export type FactoryVpsArtifact = { path: string; bytes: number; sha256: string; redacted: boolean; content?: string };

export type FactoryVpsBridgeResponse = { protocol: typeof factoryVpsProtocolVersion; requestId: string; ok: boolean; error?: string; [key: string]: unknown };

export function validateFactoryVpsCapability(value: unknown): FactoryVpsCapability {
  const item = record(value, "capability");
  if (item.protocolVersion !== factoryVpsProtocolVersion) throw new Error("factory_vps_protocol_version_mismatch");
  if (item.executorId !== factoryVpsExecutorId) throw new Error("factory_vps_executor_id_mismatch");
  const runtime = record(item.runtime, "capability.runtime"), limits = record(item.limits, "capability.limits");
  const health = choice(item.health, ["ready", "degraded", "unavailable"], "capability.health");
  const providers = array(item.providers, "capability.providers").map((entry) => {
    const provider = record(entry, "capability.providers[]");
    return { id: text(provider.id, "provider.id"), models: array(provider.models, "provider.models").map((model) => text(model, "provider.model")), credentialReady: bool(provider.credentialReady, "provider.credentialReady") };
  });
  return {
    protocolVersion: factoryVpsProtocolVersion, executorId: factoryVpsExecutorId,
    runtime: { version: text(runtime.version, "runtime.version"), revision: runtime.revision === null ? null : text(runtime.revision, "runtime.revision") }, health,
    taskModes: array(item.taskModes, "capability.taskModes").map((mode) => text(mode, "taskMode")), providers,
    runtimes: array(item.runtimes, "capability.runtimes").map((runtimeId) => text(runtimeId, "runtime")),
    limits: { timeoutMs: positive(limits.timeoutMs, "limits.timeoutMs"), providerTokens: positive(limits.providerTokens, "limits.providerTokens"), artifactBytes: positive(limits.artifactBytes, "limits.artifactBytes") },
    networkPolicy: choice(item.networkPolicy, ["allowlisted", "isolated", "denied"], "capability.networkPolicy"), cancellation: bool(item.cancellation, "capability.cancellation"), heartbeatIntervalMs: positive(item.heartbeatIntervalMs, "capability.heartbeatIntervalMs"), recovery: bool(item.recovery, "capability.recovery"), usageTelemetry: bool(item.usageTelemetry, "capability.usageTelemetry"),
  };
}

export function createFactoryVpsEnvelope(input: Omit<FactoryVpsEnvelope, "protocolVersion" | "nonce" | "issuedAt" | "source"> & { source: Omit<FactoryVpsSourceManifest, "digest"> }): FactoryVpsEnvelope {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(input.taskId)) throw new Error("factory_vps_task_id_invalid");
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("factory_vps_attempt_invalid");
  const paths = input.source.paths.map((entry) => ({ path: safeSourcePath(entry.path), bytes: boundedBytes(entry.bytes, "source bytes"), sha256: sha(entry.sha256, "source sha256") }));
  const bytes = paths.reduce((sum, entry) => sum + entry.bytes, 0);
  if (bytes !== input.source.bytes) throw new Error("factory_vps_source_bytes_mismatch");
  const source = { ...input.source, paths, digest: digest({ ...input.source, paths, digest: undefined }) };
  assertNoCredentials(input.taskSpec); assertNoCredentials(input.providerPolicy); assertNoCredentials(input.authority);
  return { ...input, protocolVersion: factoryVpsProtocolVersion, nonce: randomUUID(), issuedAt: new Date().toISOString(), source };
}

/** Verifies untrusted remote result metadata before local persistence or display. */
export function validateFactoryVpsArtifacts(artifacts: unknown, maxBytes = defaultFactoryVpsArtifactLimit): FactoryVpsArtifact[] {
  const total = { bytes: 0 };
  return array(artifacts, "artifacts").map((value) => {
    const item = record(value, "artifact"), path = safeArtifactPath(text(item.path, "artifact.path")), bytes = boundedBytes(item.bytes, "artifact.bytes");
    total.bytes += bytes; if (total.bytes > maxBytes) throw new Error("factory_vps_artifact_total_oversized");
    const artifact: FactoryVpsArtifact = { path, bytes, sha256: sha(item.sha256, "artifact.sha256"), redacted: bool(item.redacted, "artifact.redacted") };
    if (!artifact.redacted) throw new Error("factory_vps_artifact_not_redacted");
    if (item.content !== undefined) {
      const content = text(item.content, "artifact.content");
      if (Buffer.byteLength(content) > bytes || secretLike(content)) throw new Error("factory_vps_artifact_content_rejected");
      if (digest(content) !== artifact.sha256) throw new Error("factory_vps_artifact_digest_mismatch");
      artifact.content = content;
    }
    return artifact;
  });
}

export function factoryVpsUnavailableCapability(reason: string): FactoryVpsCapability & { reason: string } {
  return { protocolVersion: factoryVpsProtocolVersion, executorId: factoryVpsExecutorId, runtime: { version: "unknown", revision: null }, health: "unavailable", taskModes: ["implementation", "repair", "validation"], providers: [], runtimes: ["remote-ephemeral"], limits: { timeoutMs: 1_800_000, providerTokens: 200_000, artifactBytes: defaultFactoryVpsArtifactLimit }, networkPolicy: "allowlisted", cancellation: false, heartbeatIntervalMs: 30_000, recovery: false, usageTelemetry: false, reason };
}

/**
 * Capability discovery is intentionally opt-in. The control plane never opens
 * a public listener and never reads provider credentials; SSH authentication is
 * the only local credential boundary. The VPS bridge is responsible for using
 * its own Factory/API/provider credentials internally.
 */
export async function discoverFactoryVpsCapability(environment = process.env): Promise<(FactoryVpsCapability & { reason?: string })> {
  const host = environment.RUNFORGE_FACTORY_VPS_SSH_HOST;
  if (!host) return factoryVpsUnavailableCapability("RUNFORGE_FACTORY_VPS_SSH_HOST is not configured; remote execution is disabled.");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(host)) return factoryVpsUnavailableCapability("Remote SSH host is invalid.");
  const bridge = environment.RUNFORGE_FACTORY_VPS_BRIDGE;
  if (bridge && !/^[A-Za-z0-9._-]{1,128}$/.test(bridge)) return factoryVpsUnavailableCapability("Remote bridge command is invalid.");
  try {
    const response = await requestFactoryVpsBridge({ protocol: factoryVpsProtocolVersion, operation: "capabilities", requestId: randomUUID() }, environment, 8_000);
    if (!response.ok) throw new Error(response.error ?? "capabilities_rejected");
    return validateFactoryVpsCapability(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown remote bridge error";
    return factoryVpsUnavailableCapability(`Remote bridge handshake failed: ${message.slice(0, 160)}`);
  }
}

/** Sends exactly one bounded JSON request over the sanctioned SSH-stdio bridge.
 * The remote command is operator configuration, never derived from a task. */
export async function requestFactoryVpsBridge(request: Record<string, unknown>, environment = process.env, timeoutMs = 30_000): Promise<FactoryVpsBridgeResponse> {
  const host = environment.RUNFORGE_FACTORY_VPS_SSH_HOST;
  if (!host || !/^[A-Za-z0-9._-]{1,128}$/.test(host)) throw new Error("factory_vps_ssh_host_invalid");
  const bridge = environment.RUNFORGE_FACTORY_VPS_BRIDGE;
  if (bridge && !/^[A-Za-z0-9._-]{1,128}$/.test(bridge)) throw new Error("factory_vps_bridge_command_invalid");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 3 * 1024 * 1024) throw new Error("factory_vps_request_too_large");
  return new Promise((resolve, reject) => {
    const remoteArgv = bridge ? [bridge] : ["docker", "compose", "-p", "factory-loop", "--env-file", "/opt/factory-loop/env/.env", "-f", "/opt/factory-loop/app/deploy/docker-compose.staging.yml", "exec", "-T", "runforge-bridge-worker", "node", "/app/dist/scripts/runforge-factory-vps.js"];
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, ...remoteArgv], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error, value?: FactoryVpsBridgeResponse) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("factory_vps_bridge_timeout")); }, timeoutMs); timer.unref();
    const append = (current: string, chunk: Buffer) => { const next = current + chunk.toString(); if (Buffer.byteLength(next) > 256 * 1024) { child.kill("SIGTERM"); finish(new Error("factory_vps_bridge_output_too_large")); return current; } return next; };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(new Error(`factory_vps_bridge_start_failed: ${error.message}`)));
    child.on("close", (code) => { if (settled) return; if (code !== 0) return finish(new Error(`factory_vps_bridge_failed:${code}:${stderr.slice(0, 160)}`)); try { const value = JSON.parse(stdout) as FactoryVpsBridgeResponse; if (value.protocol !== factoryVpsProtocolVersion || typeof value.requestId !== "string" || typeof value.ok !== "boolean") throw new Error("invalid_response"); finish(undefined, value); } catch { finish(new Error("factory_vps_bridge_invalid_response")); } });
    child.stdin.end(input);
  });
}

function digest(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
function safeSourcePath(value: string): string { if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "..") || forbiddenRemoteSourcePath.test(value)) throw new Error("factory_vps_source_path_rejected"); return value; }
function safeArtifactPath(value: string): string { if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "..") || forbiddenRemoteSourcePath.test(value)) throw new Error("factory_vps_artifact_path_rejected"); return value; }
function assertNoCredentials(value: unknown): void { const encoded = canonical(value); if (secretLike(encoded)) throw new Error("factory_vps_credential_boundary_violation"); }
function secretLike(value: string): boolean { return /(?:api[_-]?key|authorization|bearer\s+|openrouter_api_key|password|secret|private[_-]?key|sk-or-v1-)/i.test(value); }
function record(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_invalid`); return value as Record<string, unknown>; }
function array(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${name}_invalid`); return value; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name}_invalid`); return value; }
function sha(value: unknown, name: string): string { const result = text(value, name); if (!/^[a-f0-9]{64}$/i.test(result)) throw new Error(`${name}_invalid`); return result.toLowerCase(); }
function positive(value: unknown, name: string): number { if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${name}_invalid`); return Number(value); }
function boundedBytes(value: unknown, name: string): number { const bytes = positive(value, name); if (bytes > defaultFactoryVpsArtifactLimit) throw new Error("factory_vps_payload_oversized"); return bytes; }
function bool(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name}_invalid`); return value; }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${name}_invalid`); return value as T; }
