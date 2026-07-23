import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalAgent } from "../../src/implementation/local-agent.js";

const envelope = {
  profile: "fast", classification: "bounded-small", model: null, taskId: "LOCAL-AGENT-1", phase: "implementation" as const, call: 1,
  limits: { maxInputContextTokens: 100, maxOutputTokens: 50, maxReasoningTokens: 10, maxWallClockMs: 1_000, earlyProgressDeadlineMs: 200, maxCallsPerPhase: 1, maxPhaseTokens: 100, maxTaskTokens: 100, maxCostUsd: 1 },
  remaining: { phaseTokens: 100, taskTokens: 100, taskTimeMs: 1_000, costUsd: 1 },
};

describe("local coding-agent runner", () => {
  it("passes the bounded envelope and turns nested streamed events into structured progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-local-agent-"));
    const agent = join(root, "agent.mjs");
    await writeFile(agent, [
      `console.log(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/value.ts" }] } }));`,
      `console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm test", aggregated_output: "FAIL tests/value.test.ts", exit_code: 1 } }));`,
      `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 3, reasoning_tokens: 2, cost_usd: 0.01 } }));`,
      `console.log(JSON.stringify({ type: "candidate_diff", message: process.env.RUNFORGE_EXECUTION_ENVELOPE }));`,
    ].join("\n"));
    const checkpoints: unknown[] = [];
    const result = await runLocalAgent(`${process.execPath} ${agent}`, null, root, "bounded prompt", 1_000, undefined, root, 0, { envelope, onUsefulProgress: (signals) => { checkpoints.push(signals); } });
    expect(result).toMatchObject({ exitCode: 0, noProgress: false, tokenUsage: 11, inputTokens: 8, outputTokens: 3, reasoningTokens: 2, costUsd: 0.01, progressSignals: { filesChanged: ["src/value.ts"], candidateDiff: expect.any(String), redTest: "FAIL tests/value.test.ts", tests: ["pnpm test"] } });
    expect(checkpoints.length).toBeGreaterThan(0);
    expect((await readFile(join(root, result.stdoutArtifact), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).at(0)).toMatchObject({ type: "item.completed" });
  });

  it("fast-fails a silent provider at the envelope early-progress deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-local-agent-silent-"));
    const agent = join(root, "silent.mjs");
    await writeFile(agent, "setInterval(() => {}, 1000);\n");
    const result = await runLocalAgent(`${process.execPath} ${agent}`, null, root, "bounded prompt", 1_000, undefined, root, 0, { envelope: { ...envelope, limits: { ...envelope.limits, earlyProgressDeadlineMs: 20 } } });
    expect(result).toMatchObject({ exitCode: null, noProgress: true, failureReason: expect.stringContaining("no_progress") });
  });
});
