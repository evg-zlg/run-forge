import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertExternalArtifactsOutsideTarget } from "../../src/run/task-run-external-target.js";

describe("external task-run target boundaries", () => {
  it("rejects artifacts inside the original repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "runforge-external-target-"));
    expect(() => assertExternalArtifactsOutsideTarget(repo, [join(repo, "validation", "run")]))
      .toThrow("must be outside --repo");
    await rm(repo, { recursive: true, force: true });
  });

  it("accepts sibling artifact and tmp roots", async () => {
    const repo = await mkdtemp(join(tmpdir(), "runforge-external-target-"));
    expect(() => assertExternalArtifactsOutsideTarget(repo, [`${repo}-artifacts`, `${repo}-tmp`])).not.toThrow();
    await rm(repo, { recursive: true, force: true });
  });
});
