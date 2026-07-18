import { describe, expect, it } from "vitest";
import { extractTokenUsage } from "../../src/implementation/executor.js";

describe("implementation provider token accounting", () => {
  it("does not charge cached input tokens against the bounded provider budget", () => {
    const output = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_792_017, cached_input_tokens: 1_703_680, output_tokens: 19_066 } });
    expect(extractTokenUsage(output)).toBe(107_403);
  });

  it("preserves explicit totals when detailed counters are unavailable", () => {
    expect(extractTokenUsage(JSON.stringify({ usage: { total_tokens: 1234 } }))).toBe(1234);
  });
});
