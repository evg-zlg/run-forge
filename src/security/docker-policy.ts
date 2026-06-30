import { existsSync } from "node:fs";

export function dockerSocketDetected(): boolean {
  return existsSync("/var/run/docker.sock");
}

export function runningInContainer(): boolean {
  return existsSync("/.dockerenv") || process.env.RUNNING_IN_CONTAINER === "true";
}

export function unsafeMountWarnings(): string[] {
  const warnings: string[] = [];
  if (dockerSocketDetected()) warnings.push("Docker socket is visible.");
  if (process.env.SSH_AUTH_SOCK) warnings.push("SSH agent environment is present.");
  return warnings;
}
