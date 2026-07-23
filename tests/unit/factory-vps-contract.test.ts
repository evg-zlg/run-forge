import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFactoryVpsEnvelope, discoverFactoryVpsCapability, factoryVpsExecutorId, factoryVpsProtocolVersion, validateFactoryVpsArtifacts, validateFactoryVpsCapability } from "../../src/implementation/factory-vps-contract.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("factory-vps protocol contract", () => {
  it("accepts a versioned credential-free capability handshake", () => {
    const capability = validateFactoryVpsCapability({ protocolVersion: factoryVpsProtocolVersion, executorId: factoryVpsExecutorId, runtime: { version: "1.2.3", revision: "abc" }, health: "ready", taskModes: ["implementation"], providers: [{ id: "openrouter", models: ["model/a"], credentialReady: true }], runtimes: ["remote-ephemeral"], limits: { timeoutMs: 1000, providerTokens: 1000, artifactBytes: 1000 }, networkPolicy: "allowlisted", cancellation: true, heartbeatIntervalMs: 1000, recovery: true, usageTelemetry: true });
    expect(capability.providers[0]).toEqual({ id: "openrouter", models: ["model/a"], credentialReady: true });
  });

  it("rejects protocol drift and credential-shaped envelope data", () => {
    expect(() => validateFactoryVpsCapability({})).toThrow("factory_vps_protocol_version_mismatch");
    expect(() => createFactoryVpsEnvelope({ taskId: "REMOTE-1", attempt: 1, generation: "g1", deadlineAt: new Date(Date.now() + 1_000).toISOString(), source: { mode: "content-addressed-bundle", repository: "repo", baseSha: "abc", paths: [{ path: "src/a.ts", bytes: 3, sha256: sha("abc") }], bytes: 3, cleanup: "remote-ephemeral" }, taskSpec: { apiKey: "nope" }, executionAgreement: {}, providerPolicy: {}, authority: {}, validation: {}, artifactManifest: { maxBytes: 1000, requireRedaction: true, requireSha256: true } })).toThrow("credential_boundary");
  });

  it("binds source files with a stable digest and rejects untrusted artifacts", () => {
    const envelope = createFactoryVpsEnvelope({ taskId: "REMOTE-1", attempt: 1, generation: "g1", deadlineAt: new Date(Date.now() + 1_000).toISOString(), source: { mode: "content-addressed-bundle", repository: "repo", baseSha: "abc", paths: [{ path: "src/a.ts", bytes: 3, sha256: sha("abc") }], bytes: 3, cleanup: "remote-ephemeral" }, taskSpec: {}, executionAgreement: {}, providerPolicy: { provider: "openrouter" }, authority: {}, validation: {}, artifactManifest: { maxBytes: 1000, requireRedaction: true, requireSha256: true } });
    expect(envelope.source.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateFactoryVpsArtifacts([{ path: "patch.diff", bytes: 2, sha256: sha("ok"), redacted: true, content: "ok" }])).toHaveLength(1);
    expect(() => validateFactoryVpsArtifacts([{ path: ".env", bytes: 2, sha256: sha("ok"), redacted: true, content: "ok" }])).toThrow("path_rejected");
    expect(() => validateFactoryVpsArtifacts([{ path: "x", bytes: 2, sha256: sha("ok"), redacted: false, content: "ok" }])).toThrow("not_redacted");
  });

  it("keeps remote discovery opt-in and reports an unavailable bridge without probing arbitrary hosts", async () => {
    await expect(discoverFactoryVpsCapability({})).resolves.toMatchObject({ executorId: factoryVpsExecutorId, health: "unavailable" });
    await expect(discoverFactoryVpsCapability({ RUNFORGE_FACTORY_VPS_SSH_HOST: "bad host" })).resolves.toMatchObject({ health: "unavailable" });
  });
});
