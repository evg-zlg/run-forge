import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointCompatibilityError, CheckpointIntegrityError, listDurableCheckpointRecords,
  listDurableCheckpoints, persistDurableCheckpoint, publishDurableCheckpointTransition,
  readDurableCheckpoint, verifyDurableCheckpoint,
} from "../../src/implementation/durable-checkpoint.js";

describe("durable implementation checkpoints", () => {
  it("atomically publishes a complete content-addressed portable v2 record", async () => {
    const root = await temporaryRoot();
    const [first, second] = await Promise.allSettled([
      persistDurableCheckpoint(root, fixture()), persistDurableCheckpoint(root, fixture()),
    ]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const checkpoint = first.status === "fulfilled" ? first.value : (second as PromiseFulfilledResult<any>).value;
    expect(checkpoint.path).toBe(join(root, "checkpoints", "checkpoint-0", checkpoint.digest));
    expect(checkpoint.manifest).toMatchObject({
      schemaVersion: 2, checkpointId: "checkpoint-0", taskId: "CHECKPOINT-TASK-1", projectId: "project-1",
      sourceRunforgeSha: "b".repeat(40), expectedBaseSha: "a".repeat(40), attempt: 1, generation: "generation-1",
      status: "created", workspace: { identity: "workspace-1", workingDirectory: "packages/app" },
      compatibility: { legacyV1VerifiedReadable: true, migration: { strategy: "read_only_no_rewrite" } },
      providerUsage: { implementation: { tokens: 10 }, repair: null, validation: { tokens: 0 }, review: { tokens: 0 } },
    });
    expect(checkpoint.manifest).toHaveProperty("taskSpec");
    expect(checkpoint.manifest).toHaveProperty("executionAgreement");
    expect(checkpoint.manifest).toHaveProperty("authoritySnapshot");
    expect(checkpoint.manifest).toHaveProperty("validationPlan");
    expect(checkpoint.manifest).toHaveProperty("completedEvidence");
    expect(checkpoint.manifest).toHaveProperty("pendingPhases");
    expect(checkpoint.manifest).toHaveProperty("secretScanResult");
    expect(checkpoint.manifest.files.every((item: { sha256: string }) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect((await readdir(join(root, "checkpoints"))).some((name) => name.startsWith("."))).toBe(false);
    await verifyDurableCheckpoint(checkpoint);
    expect((await listDurableCheckpoints(root)).map((item) => item.id)).toEqual(["checkpoint-0"]);
  });

  it("fails with structured diagnostics when payload or content address is tampered", async () => {
    const root = await temporaryRoot();
    const checkpoint = await persistDurableCheckpoint(root, fixture());
    await chmod(checkpoint.patchPath, 0o600);
    await writeFile(checkpoint.patchPath, "tampered patch\n", "utf8");
    await expect(readDurableCheckpoint(root, checkpoint.id)).rejects.toMatchObject({
      name: "CheckpointIntegrityError", code: "checkpoint_integrity_error", checkpointId: "checkpoint-0",
      artifact: "patch.diff", expected: expect.any(Object), actual: expect.any(Object),
    });

    const secondRoot = await temporaryRoot();
    const second = await persistDurableCheckpoint(secondRoot, fixture());
    const manifestPath = join(second.path, "manifest.json");
    await chmod(manifestPath, 0o600);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.projectId = "tampered-project";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await expect(readDurableCheckpoint(secondRoot, second.id)).rejects.toBeInstanceOf(CheckpointIntegrityError);
  });

  it("reads verified legacy v1 without rewriting the artifact", async () => {
    const root = await temporaryRoot();
    const { manifestPath, manifestBytes } = await writeLegacyCheckpoint(root);
    const checkpoint = await readDurableCheckpoint(root, "legacy-0");
    expect(checkpoint).toMatchObject({ manifest: { schemaVersion: 1, status: "available" } });
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
    expect((await listDurableCheckpointRecords(root, "legacy-0"))).toHaveLength(1);
  });

  it("publishes valid lifecycle transitions as linked immutable records", async () => {
    const root = await temporaryRoot();
    const created = await persistDurableCheckpoint(root, fixture());
    const candidate = await publishDurableCheckpointTransition(root, created.id, {
      status: "candidate_validation_required", expectedPreviousDigest: created.digest, reason: "candidate assembled",
    });
    const validated = await publishDurableCheckpointTransition(root, created.id, {
      status: "validated", expectedPreviousDigest: candidate.digest,
    });
    expect(validated.manifest).toMatchObject({ schemaVersion: 2, status: "validated", sequence: 2, previousDigest: candidate.digest });
    expect((await readDurableCheckpoint(root, created.id))?.digest).toBe(validated.digest);
    expect((await readDurableCheckpoint(root, created.id, created.digest))?.manifest).toMatchObject({ status: "created", sequence: 0 });
    expect(await listDurableCheckpointRecords(root, created.id)).toHaveLength(3);
    await expect(publishDurableCheckpointTransition(root, created.id, { status: "created" })).rejects.toThrow("invalid_checkpoint_transition");
    await expect(publishDurableCheckpointTransition(root, created.id, { status: "accepted", expectedPreviousDigest: candidate.digest })).rejects.toThrow("checkpoint_transition_conflict");

    const concurrentRoot = await temporaryRoot();
    const concurrent = await persistDurableCheckpoint(concurrentRoot, fixture());
    const results = await Promise.allSettled([
      publishDurableCheckpointTransition(concurrentRoot, concurrent.id, { status: "candidate_validation_required", expectedPreviousDigest: concurrent.digest }),
      publishDurableCheckpointTransition(concurrentRoot, concurrent.id, { status: "candidate_validation_required", expectedPreviousDigest: concurrent.digest }),
    ]);
    expect(results.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await listDurableCheckpointRecords(concurrentRoot, concurrent.id)).toHaveLength(2);
  });

  it("preserves explicit incompatibility and no-rewrite migration metadata", async () => {
    const root = await temporaryRoot();
    const checkpoint = await persistDurableCheckpoint(root, fixture({ incompatibilities: ["requires_git_binary_patch_v1"] }));
    expect(checkpoint.manifest).toMatchObject({
      schemaVersion: 2,
      compatibility: {
        reader: { minimumSchemaVersion: 1, maximumSchemaVersion: 2 },
        migration: { strategy: "read_only_no_rewrite", migratedFrom: null },
        incompatibilities: ["requires_git_binary_patch_v1"],
      },
    });
    const unsupportedRoot = await temporaryRoot();
    await mkdir(join(unsupportedRoot, "checkpoints", "future-0"), { recursive: true });
    await writeFile(join(unsupportedRoot, "checkpoints", "future-0", "manifest.json"), '{"schemaVersion":3,"checkpointId":"future-0"}\n');
    await expect(readDurableCheckpoint(unsupportedRoot, "future-0")).rejects.toBeInstanceOf(CheckpointCompatibilityError);

    const corruptRoot = await temporaryRoot();
    await mkdir(join(corruptRoot, "checkpoints", "corrupt-0"), { recursive: true });
    await writeFile(join(corruptRoot, "checkpoints", "corrupt-0", "manifest.json"), "not-json\n");
    await expect(readDurableCheckpoint(corruptRoot, "corrupt-0")).rejects.toMatchObject({ code: "checkpoint_integrity_error", artifact: "manifest.json" });
  });

  it("is verified-readable after a fresh read boundary", async () => {
    const root = await temporaryRoot();
    const published = await persistDurableCheckpoint(root, fixture());
    const persistedPath = published.path;
    const restarted = await readDurableCheckpoint(root, "checkpoint-0");
    expect(restarted).toMatchObject({ digest: published.digest, path: persistedPath, manifest: { generation: "generation-1" } });
    expect(await readFile(restarted!.patchPath, "utf8")).toContain("diff --git");
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    checkpointId: "checkpoint-0", taskId: "CHECKPOINT-TASK-1", projectId: "project-1",
    executionAgreementId: "ea_v1_000000000000000000000000", sourceRunforgeSha: "b".repeat(40),
    expectedBaseSha: "a".repeat(40), iteration: 0, attempt: 1, generation: "generation-1",
    kind: "implementation" as const,
    workspace: { identity: "workspace-1", workingDirectory: "packages/app", sha: null, state: "dirty" as const },
    patch: "diff --git a/a.ts b/a.ts\n", changedFiles: ["a.ts"],
    taskSpec: { schemaVersion: 2, taskId: "CHECKPOINT-TASK-1", normalized: true },
    executionAgreement: { schemaVersion: 1, id: "ea_v1_000000000000000000000000" },
    authoritySnapshot: { profile: "bounded-implementation", forbiddenAreas: [".env"] },
    validationPlan: { commands: ["pnpm test"] }, completedEvidence: [{ command: "pnpm test", outcome: "passed" }],
    pendingPhases: ["independent_review", "publication"],
    providerUsage: { implementation: { tokens: 10 }, repair: null, validation: { tokens: 0 }, review: { tokens: 0 } },
    executor: { id: "fixture" }, safetyAssertions: { targetMainMutation: false, forbiddenZonesRespected: true },
    secretScanResult: { status: "passed", findings: [] }, unresolvedFindings: [], ...overrides,
  };
}

async function temporaryRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "runforge-checkpoint-")); }

async function writeLegacyCheckpoint(root: string) {
  const path = join(root, "checkpoints", "legacy-0");
  await mkdir(path, { recursive: true });
  const payloads: Record<string, string> = {
    "patch.diff": "legacy patch\n", "changed-files.json": "[]\n", "validation.json": "[]\n",
    "usage.json": "{}\n", "executor.json": "{}\n", "safety.json": "{}\n", "unresolved-findings.json": "[]\n",
  };
  for (const [name, content] of Object.entries(payloads)) await writeFile(join(path, name), content);
  const files = Object.entries(payloads).map(([name, content]) => ({ path: name, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }));
  const manifest = { schemaVersion: 1, checkpointId: "legacy-0", iteration: 0, kind: "implementation", createdAt: "2026-07-20T00:00:00.000Z", baseSha: "a".repeat(40), workspaceSha: null, workspaceState: "dirty", status: "available", files };
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = join(path, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  return { manifestPath, manifestBytes };
}
