import { describe, expect, it } from "vitest";
import { preparationDockerArgs } from "../../src/run/runtime-preparation.js";
import { planExternalValidationTaskRun } from "../../src/run/task-run-planner.js";
import { createExecutorRequest, dockerRunArgs } from "../../src/run/task-run-executor.js";

describe("external runtime preparation policy", () => {
  it("keeps network-enabled preparation explicit, bounded, and separate from execution", () => {
    const args = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "npm ci --ignore-scripts");

    expect(args).toEqual(expect.arrayContaining([
      "--pull", "never",
      "--network", "bridge",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--env", "COREPACK_HOME=/workspace/.runforge-corepack",
      "--entrypoint", "/bin/sh",
      "runforge:local"
    ]));
    expect(args.at(-1)).toContain("npm ci --ignore-scripts");
  });

  it("prepares dependencies from the nested execution root", () => {
    const args = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "corepack yarn install --immutable", "frontend");
    expect(args).toContain("/workspace/frontend");
    expect(args).toContain("COREPACK_HOME=/workspace/frontend/.runforge-corepack");
  });

  it("rejects mount-grammar delimiters and control characters before required dependency preparation", () => {
    for (const unsafeWorkspace of ["/tmp/prepared,readonly", "/tmp/prepared=dst", "/tmp/prepared\n--mount"]) {
      expect(() => preparationDockerArgs(unsafeWorkspace, "runforge:local", "prepare-test", "npm ci", "packages/app")).toThrow(/mount grammar/i);
    }
    for (const unsafePackage of ["packages/app,readonly", "packages/app=dst", "packages/app\n--mount"]) {
      expect(() => preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "npm ci", unsafePackage)).toThrow(/mount grammar/i);
    }
  });

  it("persists Corepack only in the disposable workspace for offline validation", () => {
    const previous = process.env.COREPACK_HOME; process.env.COREPACK_HOME = "/host/private/corepack-cache";
    try {
      const prep = preparationDockerArgs("/tmp/prepared", "runforge:local", "prepare-test", "corepack pnpm install --frozen-lockfile");
      const request = createExecutorRequest({ runId: "CACHE-1", subtaskId: "validation", command: "corepack pnpm test", cwd: "/tmp/prepared", artifactDir: "/tmp/artifacts", lane: "docker-shell" });
      const validation = dockerRunArgs(request, "runforge:local", "validation-test", true);
      expect(prep).toContain("COREPACK_HOME=/workspace/.runforge-corepack");
      expect(validation).toContain("COREPACK_HOME=/workspace/.runforge-corepack");
      expect(prep).toEqual(expect.arrayContaining(["--network", "bridge"]));
      expect(validation).toEqual(expect.arrayContaining(["--network", "none"]));
      expect(`${prep.join(" ")} ${validation.join(" ")}`).not.toContain("/host/private/corepack-cache");
    } finally { if (previous === undefined) delete process.env.COREPACK_HOME; else process.env.COREPACK_HOME = previous; }
  });

  it("plans the required validation commands for the detected package manager", () => {
    expect(planExternalValidationTaskRun("validate", "package-lock.json").subtasks.map((item) => item.evidenceCommand)).toEqual([
      "npm run typecheck", "npm test", "npm run build"
    ]);
    expect(planExternalValidationTaskRun("validate", "pnpm-lock.yaml").subtasks[1]?.evidenceCommand).toBe("corepack pnpm test");
    expect(planExternalValidationTaskRun("triage", "package-lock.json", ["node --version"]).subtasks.map((item) => item.evidenceCommand)).toEqual(["node --version"]);
  });
});
