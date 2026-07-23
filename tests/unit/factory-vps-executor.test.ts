import { afterEach, describe, expect, it, vi } from "vitest";

const requestFactoryVpsBridge = vi.fn();
vi.mock("../../src/implementation/factory-vps-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/implementation/factory-vps-contract.js")>()),
  requestFactoryVpsBridge,
}));

const { runFactoryVpsImplementationExecutor } = await import("../../src/implementation/factory-vps-executor.js");

afterEach(() => { delete process.env.RUNFORGE_FACTORY_VPS_REPOSITORY; delete process.env.RUNFORGE_FACTORY_VPS_PROVIDER; delete process.env.RUNFORGE_FACTORY_VPS_MODEL; delete process.env.RUNFORGE_FACTORY_VPS_VALIDATION_TASKS; requestFactoryVpsBridge.mockReset(); });

describe("Factory VPS implementation executor", () => {
  it("dispatches, polls, imports the remote patch, and never invokes a local provider", async () => {
    process.env.RUNFORGE_FACTORY_VPS_REPOSITORY = "fixture"; process.env.RUNFORGE_FACTORY_VPS_PROVIDER = "alibaba"; process.env.RUNFORGE_FACTORY_VPS_MODEL = "qwen"; process.env.RUNFORGE_FACTORY_VPS_VALIDATION_TASKS = "test";
    requestFactoryVpsBridge.mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "d", ok: true, task: { status: "queued" } }).mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "r", ok: true, task: { status: "completed", changedFiles: ["src/fix.ts"], validation: [{ command: "test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }], receipt: { provider: "alibaba", model: "qwen", tokens: 12, costUsd: 0.01, calls: 1 } } }).mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "a", ok: true, artifact: { content: "diff --git a/src/fix.ts b/src/fix.ts\n" } });
    const result = await runFactoryVpsImplementationExecutor({ spec: { taskId: "TASK-1", task: { text: "Fix", goal: "Fix", acceptanceCriteria: ["test"] }, target: { expectedSha: "a".repeat(40) }, execution: { timeoutMs: 5_000, maxProviderTokens: 100, maxCostUsd: 1 }, executionAgreement: { profile: "standard" }, validation: { profile: "standard" }, artifacts: { root: "/tmp/runforge-factory-vps-test" } } as any, artifactRoot: "/tmp/runforge-factory-vps-test", acceptanceCriteria: ["test"], attempt: 1 } as any);
    expect(requestFactoryVpsBridge).toHaveBeenCalledTimes(3);
    expect(requestFactoryVpsBridge.mock.calls[0]![0]).toMatchObject({ operation: "dispatch", source: { repository: "fixture", baseSha: "a".repeat(40) }, providerPolicy: { provider: "alibaba", model: "qwen" }, authority: { publication: "none", deploy: "never" } });
    expect(result).toMatchObject({ status: "implemented_and_validated", changedFiles: ["src/fix.ts"], patch: expect.stringContaining("diff --git"), selectedExecutor: { id: "runforge-factory-vps", model: "qwen" }, localBranch: null, localCommit: null });
  });
});
