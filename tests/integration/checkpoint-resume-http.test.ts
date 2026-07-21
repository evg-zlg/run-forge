import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneServer } from "../../src/control-plane/server.js";

describe("public checkpoint resume HTTP contract", () => {
  it("advertises and dispatches the task-scoped localhost resume operation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "runforge-resume-http-")); let received: unknown;
    const manager: any = {
      store: { root: stateRoot, writeServiceInfo: async () => undefined }, initialize: async () => undefined, close: () => undefined, drain: async () => undefined,
      resumeCheckpoint: async (taskId: string, checkpointId: string, input: unknown) => { received = { taskId, checkpointId, input }; return { schemaVersion: 1, taskId, checkpointId, status: "validated", providerCalls: 0, providerRerun: false }; },
    };
    const server = await startControlPlaneServer({ port: 0, stateRoot, manager });
    try {
      const body = { artifactRoot: "/tmp/task/artifacts", projectId: "project-identity", targetRepository: "/tmp/project", workingDirectory: ".", expectedBaseSha: "a".repeat(40), executionAgreementId: "ea_v1_aaaaaaaaaaaaaaaaaaaaaaaa", authoritySnapshot: { allowProviderCalls: false }, candidateBinary: { path: "/tmp/runforge-candidate", sha256: "b".repeat(64), sourceRunforgeSha: "c".repeat(40), minimumCheckpointSchemaVersion: 2, maximumCheckpointSchemaVersion: 2, features: [] }, dependency: { strategy: "no_dependencies" } };
      const response = await fetch(`${server.url}/v1/tasks/RESUME-HTTP-1/checkpoints/checkpoint-0/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: "validated", providerCalls: 0, providerRerun: false });
      expect(received).toMatchObject({ taskId: "RESUME-HTTP-1", checkpointId: "checkpoint-0", input: body });
      const invalid = await fetch(`${server.url}/v1/tasks/RESUME-HTTP-1/checkpoints/checkpoint-0/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, unexpected: true }) });
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: { code: "unknown_fields" } });
    } finally { await server.close(); }
  });
});
