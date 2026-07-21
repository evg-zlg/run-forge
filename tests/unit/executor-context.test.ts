import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContextPlan } from "../../src/implementation/bounded-context.js";

describe("bounded implementation context", () => {
  it("includes only regular in-root secret-free explicit files and keeps the plan metadata-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-context-root-"));
    const outside = join(await mkdtemp(join(tmpdir(), "runforge-context-outside-")), "outside.ts");
    await writeFile(join(root, "safe.ts"), "export const value = 1;\n");
    await writeFile(join(root, "secret.ts"), `API_KEY=sk-${"x".repeat(30)}\n`);
    await writeFile(join(root, "empty.ts"), "");
    await writeFile(outside, "outside sentinel\n");
    await symlink(outside, join(root, "linked.ts"));
    const request = { spec: { task: { text: "bounded context" }, discovery: { explicitFiles: ["safe.ts", "secret.ts", "empty.ts", "linked.ts", "../escape.ts"], maxFiles: 5, maxBytes: 10_000, maxTokens: 10_000, profile: "small-scope", stopCondition: "bounded" } } } as any;

    const result = await buildContextPlan(request, root);
    const serializedPlan = JSON.stringify(result.plan);
    expect(result.prompt).toContain("--- BEGIN FILE safe.ts ---\nexport const value = 1;");
    expect(result.prompt).toContain("--- BEGIN FILE empty.ts ---");
    expect(result.prompt).not.toContain("outside sentinel");
    expect(result.prompt).not.toContain("sk-");
    expect(serializedPlan).not.toContain("export const value");
    expect(result.plan).toMatchObject({ withinBounds: true, totalFiles: 5, expansionHistory: [] });
    expect((result.plan.omitted as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "secret.ts", status: "rejected", reason: "secret-like content" }),
      expect.objectContaining({ file: "linked.ts", status: "rejected", reason: "non-regular file", bytes: 0 }),
      expect.objectContaining({ file: "../escape.ts", status: "rejected", reason: "path escapes workspace" }),
    ]));
    expect((result.plan.omitted as Array<Record<string, unknown>>)).toHaveLength(3);
    expect((result.plan.reads as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "secret.ts", status: "rejected", reason: "secret-like content" }),
      expect.objectContaining({ file: "linked.ts", status: "rejected", reason: "non-regular file" }),
      expect.objectContaining({ file: "../escape.ts", status: "rejected", reason: "path escapes workspace" }),
      expect.objectContaining({ file: "empty.ts", status: "planned", bytes: 0 }),
    ]));
  });

  it("does not read a file whose declared size exceeds the bounded byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-context-limit-"));
    await writeFile(join(root, "large.ts"), "x".repeat(2_000));
    const request = { spec: { task: { text: "bounded context" }, discovery: { explicitFiles: ["large.ts"], maxFiles: 1, maxBytes: 1_000, maxTokens: 10_000, profile: "small-scope", stopCondition: "bounded" } } } as any;
    const result = await buildContextPlan(request, root);
    expect(result.prompt).toBe("");
    expect(result.plan).toMatchObject({ withinBounds: false, totalBytes: 2_000, reads: [expect.objectContaining({ status: "rejected", reason: "context byte limit exceeded" })] });
  });

  it("deduplicates noisy evidence, retains critical lines, preserves source, telemetry has no content", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-noisy-context-"));
    const log = [
      "start",
      "info",
      "info",
      "error: fail to parse",
      "retry",
      "panic at line 10",
      ...Array.from({ length: 60 }, (_, index) => `progress ${index}`),
      "info",
      "info",
      "info",
    ].join("\n");
    const err = [
      "err: file not found",
      "err: file not found",
      "info",
    ].join("\n");
    await writeFile(join(root, "app.ts"), 'export const x = 1;\n');
    await writeFile(join(root, "build.log"), log);
    await writeFile(join(root, "run.err"), err);
    await writeFile(join(root, "validation-result.json"), `${JSON.stringify({ status: "ok" })}\n`.repeat(80));
    const request = {
      spec: {
        task: { text: "bounded context" },
        discovery: {
          explicitFiles: ["app.ts", "build.log", "run.err", "validation-result.json"],
          maxFiles: 5,
          maxBytes: 100_000,
          maxTokens: 10_000,
          profile: "small-scope",
          stopCondition: "bounded",
        },
      },
    } as any;
    const result = await buildContextPlan(request, root);

    expect(result.implementationPrompt).toContain("--- BEGIN FILE app.ts ---\nexport const x = 1;");
    expect(result.implementationPrompt).not.toContain("info\ninfo\ninfo");
    expect(result.implementationPrompt).toContain("error: fail to parse");
    expect(result.implementationPrompt).toContain("panic at line 10");
    expect(result.implementationPrompt).toContain("err: file not found");
    expect(result.implementationPrompt.match(/\{\"status\":\"ok\"\}/g)?.length).toBe(1);
    const telemetry = (result.plan.compilerTelemetry as any);
    expect(JSON.stringify(telemetry)).not.toMatch(/start|fail to parse|panic at line/);
    expect(telemetry.rawIncludedBytes).toBeGreaterThan(0);
    expect(telemetry.plannerPromptBytes).toBeGreaterThan(0);
    expect(telemetry.implementationPromptBytes).toBeGreaterThan(0);
    expect(telemetry.plannerPromptBytes).toBeGreaterThan(telemetry.implementationPromptBytes);
    expect(result.implementationPrompt.split("\n").filter((l) => /panic|error/.test(l)).length).toBeGreaterThanOrEqual(2);
    const r2 = await buildContextPlan(request, root);
    expect(result.implementationPrompt).toBe(r2.implementationPrompt);
  });

  it("compresses large README and docs text while retaining file boundaries, headings, and actionable lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-reference-context-"));
    const filler = Array.from({ length: 900 }, (_, index) => `ordinary documentation paragraph ${index}: ${"x".repeat(52)}`).join("\n");
    await writeFile(join(root, "README.md"), [
      "# RunForge",
      "Opening orientation.",
      filler,
      "## Recovery",
      "The validation failed: retry only after restoring credentials.",
      "Closing notes.",
    ].join("\n"));
    const request = { spec: { task: { text: "read README.md" }, discovery: { explicitFiles: ["README.md"], maxFiles: 1, maxBytes: 100_000, maxTokens: 100_000, profile: "small-scope", stopCondition: "bounded" } } } as any;

    const result = await buildContextPlan(request, root);
    expect(result.implementationPrompt).toContain("--- BEGIN FILE README.md ---");
    expect(result.implementationPrompt).toContain("# RunForge");
    expect(result.implementationPrompt).toContain("## Recovery");
    expect(result.implementationPrompt).toContain("validation failed");
    expect(result.implementationPrompt).not.toContain("ordinary documentation paragraph 500");
    expect(Buffer.byteLength(result.implementationPrompt)).toBeLessThan(7_000);

    const telemetry = (result.plan.compilerTelemetry as any);
    const file = telemetry.perFile.find((entry: any) => entry.file === "README.md");
    expect(file).toMatchObject({ classification: "reference-text", truncated: true });
    expect(file.inputBytes).toBeGreaterThan(file.implementationBytes);
    expect(telemetry.rawIncludedBytes).toBe(file.inputBytes);
    expect(telemetry.reductionRatio.implementation).toBeLessThan(0.2);
  });
});
