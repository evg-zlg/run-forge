import { describe, expect, it } from "vitest";
import { sourceImmutabilityCheck, taskRunCompletionStatus } from "../../src/run/task-run-source-safety.js";

describe("external source immutability completion gate", () => {
  it("turns a changed source state into a blocking failed check and failed run", () => {
    const check = sourceImmutabilityCheck(
      true,
      { path: "/repo", head: "before", status: "" },
      { path: "/repo", head: "after", status: " M source.ts" }
    );

    expect(check).toMatchObject({ result: "failed", exitCode: 1 });
    expect(check?.stderr).toContain("Blocking safety failure");
    expect(taskRunCompletionStatus({ checks: [check!], evidencePassed: true, reviewStatus: "accepted" })).toBe("failed");
  });

  it("allows completion only when the source check and other evidence pass", () => {
    const check = sourceImmutabilityCheck(
      true,
      { path: "/repo", head: "same", status: "" },
      { path: "/repo", head: "same", status: "" }
    );

    expect(check).toMatchObject({ result: "passed", exitCode: 0 });
    expect(taskRunCompletionStatus({ checks: [check!], evidencePassed: true, reviewStatus: "accepted" })).toBe("completed");
  });
});
