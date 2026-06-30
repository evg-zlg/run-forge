import { describe, expect, it } from "vitest";
import { scanSecrets } from "../../src/security/secret-scan.js";

describe("scanSecrets", () => {
  it("detects generic secret assignments without exposing full value", () => {
    const result = scanSecrets("TOKEN=abcdef1234567890");
    expect(result.status).toBe("failed");
    expect(result.matches[0].preview).toContain("abcd...7890");
  });

  it("passes ordinary logs", () => {
    expect(scanSecrets("error TS2322 in src/file.ts").status).toBe("passed");
  });
});
