import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDurableCheckpoints, persistDurableCheckpoint, readDurableCheckpoint } from "../../src/implementation/durable-checkpoint.js";

describe("durable implementation checkpoints", () => {
  it("atomically publishes a portable immutable artifact set", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-checkpoint-"));
    const checkpoint = await persistDurableCheckpoint(root, fixture());
    expect(checkpoint.manifest).toMatchObject({ schemaVersion: 2, taskId: "CHECKPOINT-TASK-1", executionAgreementId: "ea_v1_000000000000000000000000", checkpointId: "checkpoint-0", status: "available", baseSha: "a".repeat(40) });
    expect(checkpoint.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.manifest.files.map((item) => item.path)).toEqual([
      "patch.diff", "changed-files.json", "validation.json", "usage.json", "executor.json", "safety.json", "unresolved-findings.json"
    ]);
    expect(await readFile(checkpoint.patchPath, "utf8")).toContain("diff --git");
    expect((await readDurableCheckpoint(root, checkpoint.id))?.manifest.files.every((item) => item.sha256.length === 64)).toBe(true);
    expect((await listDurableCheckpoints(root)).map((item) => item.id)).toEqual(["checkpoint-0"]);
  });

  it("never overwrites an iteration checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-checkpoint-"));
    await persistDurableCheckpoint(root, fixture());
    await expect(persistDurableCheckpoint(root, { ...fixture(), patch: "replacement" })).rejects.toThrow("checkpoint_already_exists");
    expect(await readFile(join(root, "checkpoints/checkpoint-0/patch.diff"), "utf8")).toContain("diff --git");
  });

  it("fails closed when a durable payload is changed after publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-checkpoint-"));
    const checkpoint = await persistDurableCheckpoint(root, fixture());
    await writeFile(checkpoint.patchPath, "tampered patch\n", "utf8");
    await expect(readDurableCheckpoint(root, checkpoint.id)).rejects.toThrow("checkpoint_integrity_error");
  });
});

function fixture() {
  return {
    taskId: "CHECKPOINT-TASK-1", executionAgreementId: "ea_v1_000000000000000000000000",
    checkpointId: "checkpoint-0", iteration: 0, kind: "implementation" as const,
    baseSha: "a".repeat(40), workspaceSha: null, workspaceState: "dirty" as const,
    patch: "diff --git a/a.ts b/a.ts\n", changedFiles: ["a.ts"], validation: [{ command: "test", exitCode: 0 }],
    usage: { accounting: "provider", totalTokens: 10 }, executor: { id: "fixture" }, safetyAssertions: { targetMainMutation: false }, unresolvedFindings: []
  };
}
