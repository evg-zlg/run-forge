import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateValidationRawLogs } from "../../src/implementation/raw-log-gate.js";

describe("raw log gate", () => {
  it("blocks downstream when the cheap logCompression phase is over budget", async () => {
    const compress = vi.fn(async () => { throw new Error("openrouter_token_budget_exceeded"); });
    const result = await gateValidationRawLogs({
      validations: [{ artifactPath: "validation/command.json", stdout: "RAW_LOG_CANARY", stderr: "", } as any],
      artifactRoot: await mkdtemp(join(tmpdir(), "runforge-log-gate-")), iteration: 1, compress,
    });
    expect(compress).toHaveBeenCalledOnce();
    expect(result).toEqual({ blocked: true });
  });
});
