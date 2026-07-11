import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCodeRepairPlan, validateCodeRepairPlan, type CodeRepairPlan } from "../../src/run/code-repair.js";

describe("code repair executor", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("applies exact bounded replacements only to allowed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-code-repair-")); roots.push(root);
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "cli.ts"), "const limit = 1;\n");
    const plan = validPlan();
    expect(await applyCodeRepairPlan(root, plan)).toMatchObject({ files: ["src/cli.ts"] });
    expect(await readFile(join(root, "src", "cli.ts"), "utf8")).toBe("const limit = 2;\n");
  });

  it.each([".env", "package-lock.json", "deploy/app.ts", "db/migrations/1.sql", "../escape.ts"])('refuses forbidden file "%s"', (file) => {
    expect(() => validateCodeRepairPlan(validPlan({ allowed_files: [file], changes: [{ file, replacements: [{ find: "a", replace: "b" }] }] }))).toThrow();
  });

  it("refuses excessive file counts and unsafe validation commands", () => {
    expect(() => validateCodeRepairPlan(validPlan({ max_changed_files: 1, allowed_files: ["a.ts", "b.ts"], changes: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }, { file: "b.ts", replacements: [{ find: "a", replace: "b" }] }] }))).toThrow("changed-file count");
    expect(() => validateCodeRepairPlan(validPlan({ validation_commands: ["npm test && curl example.com"] }))).toThrow("safe deterministic");
  });

  it("refuses ambiguous anchors and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-code-repair-")); const outside = await mkdtemp(join(tmpdir(), "runforge-code-outside-")); roots.push(root, outside);
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "cli.ts"), "const limit = 1;\nconst limit = 1;\n");
    await expect(applyCodeRepairPlan(root, validPlan())).rejects.toThrow("anchor count mismatch");
    await writeFile(join(outside, "cli.ts"), "const limit = 1;\n"); await rm(join(root, "src", "cli.ts")); await symlink(join(outside, "cli.ts"), join(root, "src", "cli.ts"));
    await expect(applyCodeRepairPlan(root, validPlan())).rejects.toThrow("escapes workspace");
  });
});

function validPlan(override: Partial<CodeRepairPlan> = {}): CodeRepairPlan {
  return { schema_version: "runforge.code-repair.v1", candidate_id: "cli-limit", task: "Raise the CLI limit", allowed_files: ["src/cli.ts"], max_changed_files: 2, validation_commands: ["npm run typecheck", "npm test", "npm run build"], changes: [{ file: "src/cli.ts", replacements: [{ find: "const limit = 1;", replace: "const limit = 2;" }] }], ...override };
}
