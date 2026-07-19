import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DurableCheckpointInput = {
  checkpointId: string;
  iteration: number;
  kind: "implementation" | "repair";
  createdAt?: string;
  baseSha: string;
  workspaceSha: string | null;
  workspaceState: "dirty" | "committed";
  patch: string;
  changedFiles: string[];
  validation: unknown[];
  usage: Record<string, unknown>;
  executor: Record<string, unknown>;
  safetyAssertions: Record<string, boolean>;
  unresolvedFindings: string[];
};

export type DurableCheckpointManifest = {
  schemaVersion: 1;
  checkpointId: string;
  iteration: number;
  kind: DurableCheckpointInput["kind"];
  createdAt: string;
  baseSha: string;
  workspaceSha: string | null;
  workspaceState: DurableCheckpointInput["workspaceState"];
  status: "available";
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

export type DurableCheckpoint = {
  id: string;
  path: string;
  manifest: DurableCheckpointManifest;
  patchPath: string;
};

const payloadNames = [
  "patch.diff", "changed-files.json", "validation.json", "usage.json", "executor.json",
  "safety.json", "unresolved-findings.json"
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
    await writeDurable(staging, "patch.diff", input.patch);
    await writeDurable(staging, "changed-files.json", json([...new Set(input.changedFiles)].sort()));
    await writeDurable(staging, "validation.json", json(input.validation));
    await writeDurable(staging, "usage.json", json(input.usage));
    await writeDurable(staging, "executor.json", json(input.executor));
    await writeDurable(staging, "safety.json", json(input.safetyAssertions));
    await writeDurable(staging, "unresolved-findings.json", json(input.unresolvedFindings));
    const files = await Promise.all(payloadNames.map(async (path) => {
      const content = await readFile(join(staging, path));
      return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    }));
    const manifest: DurableCheckpointManifest = {
      schemaVersion: 1, checkpointId: input.checkpointId, iteration: input.iteration, kind: input.kind,
      createdAt: input.createdAt ?? new Date().toISOString(), baseSha: input.baseSha,
      workspaceSha: input.workspaceSha, workspaceState: input.workspaceState, status: "available", files
    };
    await writeDurable(staging, "manifest.json", json(manifest));
    await syncDirectory(staging);
    await rename(staging, target);
    await syncDirectory(checkpointRoot);
    return { id: input.checkpointId, path: target, manifest, patchPath: join(target, "patch.diff") };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readDurableCheckpoint(root: string, checkpointId: string): Promise<DurableCheckpoint | null> {
  assertCheckpointId(checkpointId);
  const path = join(root, "checkpoints", checkpointId);
  try {
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as DurableCheckpointManifest;
    if (manifest.checkpointId !== checkpointId || manifest.status !== "available") return null;
    await verifyCheckpointIntegrity(path, manifest);
    return { id: checkpointId, path, manifest, patchPath: join(path, "patch.diff") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function verifyCheckpointIntegrity(path: string, manifest: DurableCheckpointManifest): Promise<void> {
  const declared = manifest.files.map((item) => item.path).sort();
  const expected = [...payloadNames].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected)) throw new Error(`checkpoint_integrity_error: ${manifest.checkpointId} has an invalid payload set`);
  for (const item of manifest.files) {
    if (!payloadNames.includes(item.path as typeof payloadNames[number])) throw new Error(`checkpoint_integrity_error: ${manifest.checkpointId} contains an unsafe payload path`);
    const content = await readFile(join(path, item.path));
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== item.bytes || digest !== item.sha256) throw new Error(`checkpoint_integrity_error: ${manifest.checkpointId}/${item.path}`);
  }
}

export async function listDurableCheckpoints(root: string): Promise<DurableCheckpoint[]> {
  const names = await readdir(join(root, "checkpoints"), { withFileTypes: true }).then((items) => items.filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => item.name).sort(), () => [] as string[]);
  return (await Promise.all(names.map((name) => readDurableCheckpoint(root, name)))).filter((item): item is DurableCheckpoint => item !== null);
}

async function writeDurable(root: string, name: string, value: string): Promise<void> {
  const path = join(root, basename(name));
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error)); }
function json(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
function assertCheckpointId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value)) throw new Error(`invalid_checkpoint_id: ${value}`); }
