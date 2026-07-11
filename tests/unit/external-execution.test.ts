import { describe, expect, it } from "vitest";
import { validateExternalExecutionModes } from "../../src/run/external-execution.js";

const valid = {
  task: "repair",
  out: "validation/runs/EXTERNAL-EXECUTION-TEST",
  repo: "/external/repo",
  runtime: "docker",
  dockerImage: "runforge:local",
  prepareRuntime: "explicit",
  repairMode: "disposable",
  approvalMode: "await-owner",
  applyMode: "controlled-worktree",
  commands: [],
  timeoutMs: 1_000
};

describe("external execution gates", () => {
  it("accepts the owner-gated disposable contour", () => {
    expect(() => validateExternalExecutionModes(valid)).not.toThrow();
  });

  it.each([
    [{ runtime: "local" }, "--runtime docker"],
    [{ prepareRuntime: "none" }, "--prepare-runtime explicit"],
    [{ repairMode: "in-place" }, "only 'disposable'"],
    [{ approvalMode: "automatic" }, "Unsupported --approval-mode"],
    [{ applyMode: "main" }, "only 'controlled-worktree'"]
  ])("rejects unsafe mode %j", (override, message) => {
    expect(() => validateExternalExecutionModes({ ...valid, ...override })).toThrow(message);
  });
});
