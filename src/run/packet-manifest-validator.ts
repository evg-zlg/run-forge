import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export async function validatePacketManifest(packetDir: string, manifest: JsonObject | null, errors: string[]): Promise<void> {
  if (!Array.isArray(manifest?.artifacts)) return;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      errors.push(`packet-manifest.json artifacts[${index}] must be an object`);
      continue;
    }
    const record = artifact as JsonObject;
    if (typeof record.path !== "string" || record.path.length === 0) {
      errors.push(`packet-manifest.json artifacts[${index}] missing path`);
      continue;
    }
    if (record.type !== undefined && typeof record.type !== "string") errors.push(`packet-manifest.json artifacts[${index}] type must be a string`);
    if (typeof record.sizeBytes !== "number" || !Number.isFinite(record.sizeBytes)) errors.push(`packet-manifest.json artifacts[${index}] sizeBytes must be a finite number`);
    if (typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)) errors.push(`packet-manifest.json artifacts[${index}] hash must be a sha256 hex string`);
    const artifactPath = resolve(packetDir, record.path);
    const fromRoot = relative(packetDir, artifactPath);
    if (isAbsolute(record.path) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      errors.push(`packet-manifest.json artifacts[${index}] path escapes packet root`);
      continue;
    }
    try {
      const bytes = await readFile(artifactPath);
      const info = await stat(artifactPath);
      if (typeof record.sizeBytes === "number" && record.sizeBytes !== info.size) errors.push(`${record.path} size mismatch: manifest ${record.sizeBytes}, actual ${info.size}`);
      if (typeof record.hash === "string" && record.hash !== createHash("sha256").update(bytes).digest("hex")) errors.push(`${record.path} hash mismatch`);
    } catch {
      errors.push(`missing ${record.path}`);
    }
  }
}
