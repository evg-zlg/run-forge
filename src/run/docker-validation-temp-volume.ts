import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Owns a bounded, cross-command temp volume for exactly one validation lifecycle. */
export async function withDockerValidationTempVolume<T>(scope: string, execute: (volume: string) => Promise<T>): Promise<T> {
  const volume = dockerValidationTempVolumeName(scope);
  const { uid, gid } = dockerHostIdentity();
  await execFileAsync("docker", [
    "volume", "create", "--driver", "local",
    "--opt", "type=tmpfs", "--opt", "device=tmpfs",
    "--opt", `o=size=536870912,mode=1777,uid=${uid},gid=${gid},nosuid,nodev`,
    volume,
  ], { timeout: 10_000 });
  try {
    return await execute(volume);
  } finally {
    await execFileAsync("docker", ["volume", "rm", "-f", volume], { timeout: 10_000 });
  }
}

function dockerHostIdentity(): { uid: number; gid: number } {
  const rawUid = typeof process.getuid === "function" ? process.getuid() : 65_534;
  const rawGid = typeof process.getgid === "function" ? process.getgid() : 65_534;
  return {
    uid: Number.isSafeInteger(rawUid) && rawUid >= 0 ? rawUid : 65_534,
    gid: Number.isSafeInteger(rawGid) && rawGid >= 0 ? rawGid : 65_534,
  };
}

function dockerValidationTempVolumeName(scope: string): string {
  const safe = scope.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "validation";
  return `runforge-validation-tmp-${safe}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
