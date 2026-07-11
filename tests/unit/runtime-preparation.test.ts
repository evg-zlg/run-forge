import { describe, expect, it } from "vitest";
import { preparationDockerArgs } from "../../src/run/runtime-preparation.js";
import { planExternalValidationTaskRun } from "../../src/run/task-run-planner.js";

describe("external runtime preparation policy", () => {
  it("keeps network-enabled preparation explicit, bounded, and separate from execution", () => {
    const args = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "npm ci --ignore-scripts");

    expect(args).toEqual(expect.arrayContaining([
      "--pull", "never",
      "--network", "bridge",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--entrypoint", "/bin/sh",
      "runforge:local"
    ]));
    expect(args.at(-1)).toContain("npm ci --ignore-scripts");
  });

  it("plans the required validation commands for the detected package manager", () => {
    expect(planExternalValidationTaskRun("validate", "package-lock.json").subtasks.map((item) => item.evidenceCommand)).toEqual([
      "npm run typecheck", "npm test", "npm run build"
    ]);
    expect(planExternalValidationTaskRun("validate", "pnpm-lock.yaml").subtasks[1]?.evidenceCommand).toBe("corepack pnpm test");
  });
});
