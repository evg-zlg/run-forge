import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDogfoodArtifacts,
  COMMAND_RESULT_KEYS,
  DOGFOOD_RAILS_CHECKS,
  DOGFOOD_RAILS_OUT_ROOT,
  REQUIRED_DOGFOOD_RAILS_ARTIFACTS
} from "../../scripts/dogfood-rails.js";

describe("dogfood rails", () => {
  it("keeps the command-check subset deterministic and non-recursive", () => {
    expect(DOGFOOD_RAILS_OUT_ROOT).toBe("artifacts/runs/dogfood-rails");
    expect(DOGFOOD_RAILS_CHECKS.map((check) => check.command)).toEqual([
      "pnpm check:structure",
      "pnpm check:governance",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "pnpm validation:run"
    ]);
    const commands = DOGFOOD_RAILS_CHECKS.map((check) => check.command as string);
    expect(commands.some((command) => command.includes("dogfood:rails"))).toBe(false);
    expect(commands).not.toContain("pnpm dogfood");
  });

  it("requires root and command-check artifacts", () => {
    expect([...REQUIRED_DOGFOOD_RAILS_ARTIFACTS].sort()).toEqual([
      "command-output.txt",
      "command-result.json",
      "context-summary.json",
      "review.md",
      "run.json",
      "safety-report.json",
      "trajectory.json"
    ]);
  });

  it("validates the command-result full structured field set", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "runforge-dogfood-rails-"));
    for (const artifact of REQUIRED_DOGFOOD_RAILS_ARTIFACTS) {
      await writeFile(join(runDir, artifact), artifact === "command-result.json" ? commandResultJson() : "");
    }

    await expect(assertDogfoodArtifacts(runDir)).resolves.toBeUndefined();
  });
});

function commandResultJson(): string {
  const result = Object.fromEntries(COMMAND_RESULT_KEYS.map((key) => [key, null])) as Record<string, unknown>;
  result.command = "pnpm check:structure";
  result.blocked = false;
  result.stdout = "";
  result.stderr = "";
  result.executed = true;
  return JSON.stringify(result);
}
