import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const requestFactoryVpsBridge = vi.fn();
vi.mock("../../src/implementation/factory-vps-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/implementation/factory-vps-contract.js")>()),
  requestFactoryVpsBridge,
}));

const { runFactoryVpsImplementationExecutor } = await import("../../src/implementation/factory-vps-executor.js");

afterEach(() => { delete process.env.RUNFORGE_FACTORY_VPS_REPOSITORY; delete process.env.RUNFORGE_FACTORY_VPS_PROVIDER; delete process.env.RUNFORGE_FACTORY_VPS_MODEL; delete process.env.RUNFORGE_FACTORY_VPS_VALIDATION_TASKS; delete process.env.RUNFORGE_FACTORY_VPS_SOURCE_MODE; requestFactoryVpsBridge.mockReset(); });

describe("Factory VPS implementation executor", () => {
  it("dispatches, polls, imports the remote patch, and never invokes a local provider", async () => {
    process.env.RUNFORGE_FACTORY_VPS_REPOSITORY = "fixture"; process.env.RUNFORGE_FACTORY_VPS_PROVIDER = "alibaba"; process.env.RUNFORGE_FACTORY_VPS_MODEL = "qwen"; process.env.RUNFORGE_FACTORY_VPS_VALIDATION_TASKS = "test";
    requestFactoryVpsBridge.mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "d", ok: true, task: { status: "queued" } }).mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "r", ok: true, task: { status: "completed", changedFiles: ["src/fix.ts"], validation: [{ command: "test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }], receipt: { provider: "alibaba", model: "qwen", tokens: 12, costUsd: 0.01, calls: 1 } } }).mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "a", ok: true, artifact: { content: "diff --git a/src/fix.ts b/src/fix.ts\n" } });
    const result = await runFactoryVpsImplementationExecutor({ spec: { taskId: "TASK-1", task: { text: "Fix", goal: "Fix", acceptanceCriteria: ["test"] }, target: { expectedSha: "a".repeat(40) }, execution: { timeoutMs: 5_000, maxProviderTokens: 100, maxCostUsd: 1 }, executionAgreement: { profile: "standard" }, validation: { profile: "standard" }, artifacts: { root: "/tmp/runforge-factory-vps-test" } } as any, artifactRoot: "/tmp/runforge-factory-vps-test", acceptanceCriteria: ["test"], attempt: 1 } as any);
    expect(requestFactoryVpsBridge).toHaveBeenCalledTimes(3);
    expect(requestFactoryVpsBridge.mock.calls[0]![0]).toMatchObject({ operation: "dispatch", source: { repository: "fixture", baseSha: "a".repeat(40) }, providerPolicy: { provider: "alibaba", model: "qwen" }, authority: { publication: "none", deploy: "never" } });
    expect(result).toMatchObject({ status: "implemented_and_validated", changedFiles: ["src/fix.ts"], patch: expect.stringContaining("diff --git"), selectedExecutor: { id: "runforge-factory-vps", model: "qwen" }, localBranch: null, localCommit: null });
  });

  it("builds an integrity-bound portable bundle from the accepted Git tree", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "runforge-factory-vps-bundle-"));
    await git(repositoryRoot, ["init", "--quiet"]);
    await git(repositoryRoot, ["config", "user.email", "test@example.invalid"]);
    await git(repositoryRoot, ["config", "user.name", "RunForge test"]);
    await writeFile(join(repositoryRoot, "fix.js"), "export const answer = 41;\n", "utf8");
    await writeFile(join(repositoryRoot, "fix.test.js"), "import { answer } from './fix.js'; if (answer !== 41) process.exit(1);\n", "utf8");
    await git(repositoryRoot, ["add", "--", "fix.js", "fix.test.js"]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture"]);
    const expectedSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(repositoryRoot, "fix.js"), "export const answer = 999;\n", "utf8");
    process.env.RUNFORGE_FACTORY_VPS_REPOSITORY = "synthetic-fixture";
    process.env.RUNFORGE_FACTORY_VPS_PROVIDER = "alibaba";
    process.env.RUNFORGE_FACTORY_VPS_MODEL = "qwen";
    process.env.RUNFORGE_FACTORY_VPS_SOURCE_MODE = "bundle";
    requestFactoryVpsBridge
      .mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "d", ok: true, task: { status: "queued" } })
      .mockResolvedValueOnce({ protocol: "runforge-factory-vps/v1", requestId: "r", ok: true, task: { status: "completed", changedFiles: [] } });
    const result = await runFactoryVpsImplementationExecutor(requestFor(repositoryRoot, expectedSha));
    const dispatch = requestFactoryVpsBridge.mock.calls[0]![0] as any;
    expect(result.status).toBe("no_change_required");
    expect(dispatch.source).toMatchObject({ mode: "bundle", repository: "synthetic-fixture", encoding: "base64-json-v1" });
    expect(dispatch.source.baseSha).toBe(dispatch.source.sha256);
    const raw = Buffer.from(dispatch.source.contentBase64, "base64");
    expect(raw.byteLength).toBe(dispatch.source.bytes);
    expect(dispatch.source.sha256).toBe(sha(raw));
    const archive = JSON.parse(raw.toString("utf8"));
    expect(archive.files.map((file: { path: string }) => file.path)).toEqual(["fix.js", "fix.test.js"]);
    expect(Buffer.from(archive.files[0].contentBase64, "base64").toString("utf8")).toBe("export const answer = 41;\n");
    expect(dispatch.integrity.envelopeSha256).toBe(sha(Buffer.from(JSON.stringify({ ...dispatch, integrity: undefined }))));
  });

  it("fails closed instead of transferring forbidden tracked source paths", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "runforge-factory-vps-bundle-secret-"));
    await git(repositoryRoot, ["init", "--quiet"]);
    await git(repositoryRoot, ["config", "user.email", "test@example.invalid"]);
    await git(repositoryRoot, ["config", "user.name", "RunForge test"]);
    await writeFile(join(repositoryRoot, ".env"), "NOT_A_REAL_SECRET=fixture\n", "utf8");
    await git(repositoryRoot, ["add", "--", ".env"]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture"]);
    const expectedSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    process.env.RUNFORGE_FACTORY_VPS_REPOSITORY = "synthetic-fixture";
    process.env.RUNFORGE_FACTORY_VPS_PROVIDER = "alibaba";
    process.env.RUNFORGE_FACTORY_VPS_MODEL = "qwen";
    process.env.RUNFORGE_FACTORY_VPS_SOURCE_MODE = "bundle";
    await expect(runFactoryVpsImplementationExecutor(requestFor(repositoryRoot, expectedSha))).rejects.toThrow("factory_vps_bundle_forbidden_path");
    expect(requestFactoryVpsBridge).not.toHaveBeenCalled();
  });
});

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function requestFor(repository: string, expectedSha: string): any {
  return { spec: { taskId: "TASK-1", task: { text: "Fix", goal: "Fix", acceptanceCriteria: ["test"] }, target: { repository, expectedSha }, execution: { timeoutMs: 5_000, maxProviderTokens: 100, maxCostUsd: 1 }, executionAgreement: { profile: "standard" }, validation: { profile: "standard" }, artifacts: { root: "/tmp/runforge-factory-vps-test" } }, targetRepository: repository, artifactRoot: "/tmp/runforge-factory-vps-test", acceptanceCriteria: ["test"], attempt: 1 };
}
