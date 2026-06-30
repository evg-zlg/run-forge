import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/triage/failure-classifier.js";

describe("classifyFailure", () => {
  it("detects typecheck failures", () => {
    expect(classifyFailure("error TS2322: Type error").category).toBe("typecheck_failure");
  });

  it("detects test failures", () => {
    expect(classifyFailure("FAIL test\nAssertionError expected 1 received 2").category).toBe("test_failure");
  });

  it("falls back to unknown", () => {
    expect(classifyFailure("something unusual happened").category).toBe("unknown_failure");
  });
});
