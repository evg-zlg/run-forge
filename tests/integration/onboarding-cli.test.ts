import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("public onboarding CLI", () => {
  it("emits machine-readable onboarding JSON", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "onboarding", "--format", "json"]);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, product: "RunForge", transport: "local-cli", entrypoint: "runforge" });
  });

  it("keeps the legacy doctor human command working", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "doctor"]);
    expect(stdout).toContain("RunForge doctor:");
    expect(stdout).toContain("Node:");
  });

  it("rejects legacy execution flags in TaskSpec mode instead of ignoring them", async () => {
    await expect(execFileAsync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "task-run", "start", "--spec", "/missing.json", "--timeout-ms", "1000"]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("cannot be combined with legacy options") });
  });
});
