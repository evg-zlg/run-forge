import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CheckpointCompatibilityError, CheckpointIntegrityError, checkpointLifecycleStatuses,
  type CheckpointFile, type CheckpointLifecycleStatus, type CheckpointTransitionInput,
  type DurableCheckpoint, type DurableCheckpointInput, type DurableCheckpointManifest,
  type LegacyDurableCheckpointManifest,
} from "./durable-checkpoint-types.js";

export * from "./durable-checkpoint-types.js";
export { durableCheckpointContext } from "./durable-checkpoint-context.js";

const legacyPayloadNames = [
  "patch.diff", "changed-files.json", "validation.json", "usage.json", "executor.json",
  "safety.json", "unresolved-findings.json",
] as const;
const v2PayloadNames = [
  ...legacyPayloadNames, "task-spec.json", "execution-agreement.json", "authority.json",
  "validation-plan.json", "pending-phases.json", "secret-scan.json",
] as const;

export async function persistDurableCheckpoint(root: string, input: DurableCheckpointInput): Promise<DurableCheckpoint> {
  assertCheckpointId(input.checkpointId);
  const checkpointRoot = join(root, "checkpoints");
  const target = join(checkpointRoot, input.checkpointId);
  if (await exists(target)) throw new Error(`checkpoint_already_exists: ${input.checkpointId}`);
  await mkdir(checkpointRoot, { recursive: true });
  const staging = join(checkpointRoot, `.${input.checkpointId}.${randomUUID()}.tmp`);
  await mkdir(staging, { recursive: false });
  try {
    const recordStaging = join(staging, "record");
    await mkdir(recordStaging);
    const payloads = payloadValues(input);
    for (const [name, value] of payloads) await writeDurable(recordStaging, name, value);
    const files = await fileMetadata(recordStaging, v2PayloadNames);
    const patchFile = files.find((item) => item.path === "patch.diff")!;
    const manifest: DurableCheckpointManifest = {
      schemaVersion: 2, checkpointId: input.checkpointId, taskId: input.taskId, projectId: input.projectId,
      executionAgreementId: input.executionAgreementId, sourceRunforgeSha: input.sourceRunforgeSha,
      expectedBaseSha: input.expectedBaseSha, baseSha: input.expectedBaseSha, iteration: input.iteration,
      attempt: input.attempt, generation: input.generation, kind: input.kind,
      createdAt: input.createdAt ?? new Date().toISOString(), status: input.lifecycleStatus ?? "created",
      sequence: 0, previousDigest: null, transitionReason: null, workspace: input.workspace,
      patch: { path: "patch.diff", sha256: patchFile.sha256 }, changedFiles: normalizedStrings(input.changedFiles),
      taskSpec: input.taskSpec, executionAgreement: input.executionAgreement, authoritySnapshot: input.authoritySnapshot,
      validationPlan: input.validationPlan, completedEvidence: input.completedEvidence,
      pendingPhases: normalizedStrings(input.pendingPhases), providerUsage: input.providerUsage,
      safetyAssertions: input.safetyAssertions, secretScanResult: input.secretScanResult, files,
      integrity: { algorithm: "sha256", payloadSetSha256: payloadSetDigest(files), contentAddressedBy: "manifest.json" },
      compatibility: compatibility(input.incompatibilities ?? []),
    };
    const manifestText = json(manifest);
    const recordDigest = digest(manifestText);
    await writeDurable(recordStaging, "manifest.json", manifestText);
    await syncDirectory(recordStaging);
    await chmodRecord(recordStaging);
    await rename(recordStaging, join(staging, recordDigest));
    await syncDirectory(staging);
    await rename(staging, target);
    await syncDirectory(checkpointRoot);
    return checkpointResult(input.checkpointId, join(target, recordDigest), manifest, manifestText);
  } catch (error) {
    await discardStaging(staging);
    throw error;
  }
}

export async function publishDurableCheckpointTransition(root: string, checkpointId: string, transition: CheckpointTransitionInput): Promise<DurableCheckpoint> {
  assertCheckpointId(checkpointId);
  const lock = join(root, "checkpoints", checkpointId, ".transition.lock");
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`checkpoint_transition_conflict: ${checkpointId}`); throw error; }
  try { return await publishTransitionLocked(root, checkpointId, transition); }
  finally { await rmdir(lock).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

async function publishTransitionLocked(root: string, checkpointId: string, transition: CheckpointTransitionInput): Promise<DurableCheckpoint> {
  const previous = await readDurableCheckpoint(root, checkpointId);
  if (!previous) throw new Error(`checkpoint_not_found: ${checkpointId}`);
  if (previous.manifest.schemaVersion !== 2) throw new CheckpointCompatibilityError(checkpointId, 1);
  if (transition.expectedPreviousDigest && transition.expectedPreviousDigest !== previous.digest) throw new Error(`checkpoint_transition_conflict: ${checkpointId}`);
  assertTransition(previous.manifest.status, transition.status);
  const manifest: DurableCheckpointManifest = {
    ...previous.manifest, status: transition.status, sequence: previous.manifest.sequence + 1,
    previousDigest: previous.digest, transitionReason: transition.reason ?? null,
    createdAt: transition.createdAt ?? new Date().toISOString(),
  };
  const checkpointPath = join(root, "checkpoints", checkpointId);
  const staging = join(checkpointPath, `.${randomUUID()}.tmp`);
  await mkdir(staging, { recursive: false });
  try {
    for (const name of v2PayloadNames) await writeDurable(staging, name, await readFile(join(previous.path, name)));
    const manifestText = json(manifest);
    const recordDigest = digest(manifestText);
    await writeDurable(staging, "manifest.json", manifestText);
    await syncDirectory(staging);
    await chmodRecord(staging);
    await rename(staging, join(checkpointPath, recordDigest));
    await syncDirectory(checkpointPath);
    return checkpointResult(checkpointId, join(checkpointPath, recordDigest), manifest, manifestText);
  } catch (error) {
    await discardStaging(staging);
    throw error;
  }
}

export async function readDurableCheckpoint(root: string, checkpointId: string, recordDigest?: string): Promise<DurableCheckpoint | null> {
  assertCheckpointId(checkpointId);
  const checkpointPath = join(root, "checkpoints", checkpointId);
  try {
    if (await exists(join(checkpointPath, "manifest.json"))) return readRecord(checkpointId, checkpointPath);
    const records = await listRecordDirectories(checkpointPath);
    if (!records.length) return null;
    const verified = await Promise.all(records.map((name) => readRecord(checkpointId, join(checkpointPath, name), name)));
    if (recordDigest) return verified.find((item) => item.digest === recordDigest) ?? null;
    return selectLatestRecord(checkpointId, verified);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function verifyDurableCheckpoint(checkpoint: DurableCheckpoint): Promise<void> {
  await readRecord(checkpoint.id, checkpoint.path, checkpoint.digest);
}

export async function listDurableCheckpoints(root: string): Promise<DurableCheckpoint[]> {
  const names = await readdir(join(root, "checkpoints"), { withFileTypes: true }).then(
    (items) => items.filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => item.name).sort(),
    () => [] as string[],
  );
  return (await Promise.all(names.map((name) => readDurableCheckpoint(root, name)))).filter((item): item is DurableCheckpoint => item !== null);
}

export async function listDurableCheckpointRecords(root: string, checkpointId: string): Promise<DurableCheckpoint[]> {
  const latest = await readDurableCheckpoint(root, checkpointId);
  if (!latest) return [];
  if (latest.manifest.schemaVersion === 1) return [latest];
  const names = await listRecordDirectories(join(root, "checkpoints", checkpointId));
  return Promise.all(names.map((name) => readRecord(checkpointId, join(root, "checkpoints", checkpointId, name), name)));
}

async function readRecord(checkpointId: string, path: string, expectedDigest?: string): Promise<DurableCheckpoint> {
  const manifestText = await readFile(join(path, "manifest.json"), "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(manifestText); }
  catch (error) { integrity(checkpointId, "manifest.json", "valid JSON", error instanceof Error ? error.message : String(error)); }
  const manifest = parseManifest(parsed, checkpointId);
  const manifestDigest = digest(manifestText);
  if (expectedDigest && manifestDigest !== expectedDigest) integrity(checkpointId, "manifest.json", expectedDigest, manifestDigest);
  await verifyRecord(path, manifest, expectedDigest);
  return checkpointResult(checkpointId, path, manifest, manifestText);
}

async function verifyRecord(path: string, manifest: LegacyDurableCheckpointManifest | DurableCheckpointManifest, expectedDigest?: string): Promise<void> {
  const names = manifest.schemaVersion === 1 ? legacyPayloadNames : v2PayloadNames;
  const declared = manifest.files.map((item) => item.path).sort();
  if (jsonKey(declared) !== jsonKey([...names].sort())) integrity(manifest.checkpointId, "payload-set", [...names].sort(), declared);
  const entries = (await readdir(path)).sort();
  if (jsonKey(entries) !== jsonKey(["manifest.json", ...names].sort())) integrity(manifest.checkpointId, "directory", ["manifest.json", ...names].sort(), entries);
  for (const item of manifest.files) {
    if (!names.includes(item.path as never)) integrity(manifest.checkpointId, item.path, "safe payload path", "undeclared path");
    const filePath = join(path, item.path);
    if (!(await lstat(filePath)).isFile()) integrity(manifest.checkpointId, item.path, "regular file", "non-file");
    const content = await readFile(filePath);
    const actual = { bytes: content.byteLength, sha256: digest(content) };
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) integrity(manifest.checkpointId, item.path, { bytes: item.bytes, sha256: item.sha256 }, actual);
  }
  if (manifest.schemaVersion === 2) {
    const actualSetDigest = payloadSetDigest(manifest.files);
    if (actualSetDigest !== manifest.integrity.payloadSetSha256) integrity(manifest.checkpointId, "payload-set-sha256", manifest.integrity.payloadSetSha256, actualSetDigest);
    if (manifest.patch.sha256 !== manifest.files.find((item) => item.path === manifest.patch.path)?.sha256) integrity(manifest.checkpointId, "patch.sha256", manifest.patch.sha256, "file hash mismatch");
    if (expectedDigest && basename(path) !== expectedDigest) integrity(manifest.checkpointId, "content-address", expectedDigest, basename(path));
  }
}

function parseManifest(value: unknown, checkpointId: string): LegacyDurableCheckpointManifest | DurableCheckpointManifest {
  if (!isObject(value)) integrity(checkpointId, "manifest.json", "object", typeof value);
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) throw new CheckpointCompatibilityError(checkpointId, manifest.schemaVersion);
  if (manifest.checkpointId !== checkpointId) integrity(checkpointId, "checkpointId", checkpointId, manifest.checkpointId);
  if (!Array.isArray(manifest.files) || manifest.files.some((item) => !validFile(item))) integrity(checkpointId, "files", "valid sha256 file metadata", manifest.files);
  if (manifest.schemaVersion === 1) validateLegacy(manifest, checkpointId);
  else validateV2(manifest, checkpointId);
  return manifest as unknown as LegacyDurableCheckpointManifest | DurableCheckpointManifest;
}

function validateLegacy(value: Record<string, unknown>, id: string): void {
  const validWorkspaceSha = value.workspaceSha === null || isGitSha(value.workspaceSha);
  if (value.status !== "available" || !validCommon(value) || !validWorkspaceSha || !["dirty", "committed"].includes(String(value.workspaceState))) integrity(id, "manifest-v1", "valid legacy metadata", value);
}

function validateV2(value: Record<string, unknown>, id: string): void {
  const strings = ["taskId", "projectId", "executionAgreementId", "sourceRunforgeSha", "expectedBaseSha", "baseSha", "generation"];
  if (!validCommon(value) || strings.some((key) => typeof value[key] !== "string" || !value[key]) || !isGitSha(value.sourceRunforgeSha) || !isGitSha(value.expectedBaseSha) || value.baseSha !== value.expectedBaseSha) integrity(id, "manifest-v2", "valid portable bindings", value);
  if (!checkpointLifecycleStatuses.includes(value.status as CheckpointLifecycleStatus) || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) integrity(id, "lifecycle", "valid status/attempt/sequence", { status: value.status, attempt: value.attempt, sequence: value.sequence });
  if (!isObject(value.workspace) || typeof value.workspace.identity !== "string" || typeof value.workspace.workingDirectory !== "string") integrity(id, "workspace", "workspace identity and working directory", value.workspace);
  if (!isObject(value.integrity) || value.integrity.algorithm !== "sha256" || !isSha(value.integrity.payloadSetSha256) || !isObject(value.compatibility)) integrity(id, "compatibility", "schema-v2 integrity and compatibility metadata", value.compatibility);
  if (!Array.isArray(value.changedFiles) || !Array.isArray(value.completedEvidence) || !Array.isArray(value.pendingPhases) || !isObject(value.providerUsage) || !isObject(value.safetyAssertions)) integrity(id, "portable-metadata", "complete checkpoint metadata", value);
}

function selectLatestRecord(id: string, records: DurableCheckpoint[]): DurableCheckpoint {
  const v2 = records.filter((item): item is DurableCheckpoint & { manifest: DurableCheckpointManifest } => item.manifest.schemaVersion === 2);
  const referenced = new Set(v2.map((item) => item.manifest.previousDigest).filter((item): item is string => item !== null));
  const leaves = v2.filter((item) => !referenced.has(item.digest));
  if (leaves.length !== 1) integrity(id, "lifecycle-chain", "one immutable head", leaves.map((item) => item.digest));
  const latest = leaves[0]!;
  if (latest.manifest.sequence !== v2.length - 1) integrity(id, "lifecycle-sequence", v2.length - 1, latest.manifest.sequence);
  return latest;
}

function payloadValues(input: DurableCheckpointInput): Array<[typeof v2PayloadNames[number], string | Buffer]> {
  return [
    ["patch.diff", input.patch], ["changed-files.json", json(normalizedStrings(input.changedFiles))],
    ["validation.json", json(input.completedEvidence)], ["usage.json", json(input.providerUsage)],
    ["executor.json", json(input.executor)], ["safety.json", json(input.safetyAssertions)],
    ["unresolved-findings.json", json(input.unresolvedFindings)], ["task-spec.json", json(input.taskSpec)],
    ["execution-agreement.json", json(input.executionAgreement)], ["authority.json", json(input.authoritySnapshot)],
    ["validation-plan.json", json(input.validationPlan)], ["pending-phases.json", json(normalizedStrings(input.pendingPhases))],
    ["secret-scan.json", json(input.secretScanResult)],
  ];
}

function compatibility(incompatibilities: string[]) {
  return { reader: { minimumSchemaVersion: 1 as const, maximumSchemaVersion: 2 as const }, legacyV1VerifiedReadable: true as const, migration: { strategy: "read_only_no_rewrite" as const, migratedFrom: null }, incompatibilities: normalizedStrings(incompatibilities) };
}

function assertTransition(from: CheckpointLifecycleStatus, to: CheckpointLifecycleStatus): void {
  const allowed: Record<CheckpointLifecycleStatus, CheckpointLifecycleStatus[]> = {
    created: ["candidate_validation_required", "rejected"], candidate_validation_required: ["validated", "rejected"],
    validated: ["accepted", "rejected", "superseded"], rejected: ["superseded"], accepted: ["superseded"], superseded: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`invalid_checkpoint_transition: ${from} -> ${to}`);
}

async function fileMetadata(root: string, names: readonly string[]): Promise<CheckpointFile[]> {
  return Promise.all(names.map(async (path) => { const content = await readFile(join(root, path)); return { path, bytes: content.byteLength, sha256: digest(content) }; }));
}
async function listRecordDirectories(path: string): Promise<string[]> { return (await readdir(path, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.name.startsWith(".") && isSha(item.name)).map((item) => item.name).sort(); }
async function discardStaging(path: string): Promise<void> { if (!(await exists(path))) return; await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await chmod(join(path, item.name), 0o700); await rm(path, { recursive: true, force: true }); }
async function chmodRecord(path: string): Promise<void> { for (const name of ["manifest.json", ...v2PayloadNames]) await chmod(join(path, name), 0o400); await chmod(path, 0o500); }
async function writeDurable(root: string, name: string, value: string | Buffer): Promise<void> { const handle = await open(join(root, basename(name)), "wx", 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error)); }
function checkpointResult(id: string, path: string, manifest: LegacyDurableCheckpointManifest | DurableCheckpointManifest, text: string): DurableCheckpoint { return { id, path, manifest, patchPath: join(path, "patch.diff"), digest: digest(text) }; }
function payloadSetDigest(files: CheckpointFile[]): string { return digest(files.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join("")); }
function validCommon(value: Record<string, unknown>): boolean { return Number.isSafeInteger(value.iteration) && Number(value.iteration) >= 0 && ["implementation", "repair"].includes(String(value.kind)) && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && isGitSha(value.baseSha); }
function validFile(value: unknown): value is CheckpointFile { return isObject(value) && typeof value.path === "string" && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && isSha(value.sha256); }
function isObject(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isGitSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value); }
function normalizedStrings(values: string[]): string[] { return [...new Set(values)].sort(); }
function json(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
function jsonKey(value: unknown): string { return JSON.stringify(value); }
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function integrity(id: string, artifact: string, expected: unknown, actual: unknown): never { throw new CheckpointIntegrityError(id, artifact, expected, actual); }
function assertCheckpointId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value)) throw new Error(`invalid_checkpoint_id: ${value}`); }
