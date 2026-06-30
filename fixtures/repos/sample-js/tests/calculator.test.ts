import { describe, expect, it } from "vitest";
import { add } from "../src/calculator";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(1, 1)).toBe(3);
  });
});
