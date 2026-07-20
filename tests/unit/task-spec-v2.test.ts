import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_PARTIES, EXECUTION_PHASE_IDS, EXECUTION_PROFILES } from "../../src/product/execution-agreement.js";
import { publicTaskSpecContract, taskSpecV2Schema } from "../../src/product/task-spec-contract.js";
import { loadTaskSpecV2, normalizeTaskSpecV2, redactedTaskSpec } from "../../src/product/task-spec-v2.js";
import { readExternalValidationResults } from "../../src/product/task-result-contract.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("TaskSpec v2", () => {
  it("requires an explicit supported execution mode", async () => {
    const repo = await gitRepo();
    const value = minimal(repo) as Record<string, any>;
    delete value.execution;
    await expect(normalizeTaskSpecV2(value)).rejects.toThrow("execution is required");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), execution: { mode: "guess" } })).rejects.toThrow("execution.mode must be one of");
  });
  it("normalizes auto-discovery deterministically", async () => {
    const repo = await gitRepo();
    const first = await normalizeTaskSpecV2(minimal(repo));
    const second = await normalizeTaskSpecV2(minimal(repo));
    expect(first).toEqual(second);
    expect(first.validation.commands).toEqual(["npm test", "npm run build"]);
    expect(first.authority.profile).toBe("read-only");
    expect(first.artifacts.root).toMatch(/\.runforge-artifacts\/[^/]+\/TEST-TASK-1$/);
    expect(redactedTaskSpec(first)).toEqual(first);
  });

  it("defaults omitted provider routing to the legacy local-only contract", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2(minimal(repo))).resolves.toMatchObject({
      providerRouting: { provider: "local", fallbackPolicy: "none", models: {}, maxCalls: 4, retry: { maxAttempts: 1 } }
    });
  });

  it("normalizes bounded OpenRouter routing without requiring every phase model", async () => {
    const repo = await gitRepo();
    const providerRouting = {
      provider: "openrouter", fallbackPolicy: "same_provider", models: { planner: "openai/gpt-5" },
      maxCalls: 6, tokenBudget: { total: 50000, perPhase: { planner: 12000, implementer: 25000, repair: 8000, reviewer: 5000 } },
      costBudgetUsd: 12.5, timeoutMs: 120000, retry: { maxAttempts: 2 }
    };
    const spec = await normalizeTaskSpecV2({ ...minimal(repo), providerRouting });
    expect(spec.providerRouting).toEqual(providerRouting);
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(taskSpecV2Schema);
    expect(validate({ ...minimal(repo), providerRouting }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects invalid provider fallbacks and credential-shaped routing input", async () => {
    const repo = await gitRepo();
    const routing = { provider: "local", fallbackPolicy: "same_provider", maxCalls: 1, tokenBudget: { total: 1000, perPhase: {} }, timeoutMs: 1000, retry: { maxAttempts: 2 } };
    await expect(normalizeTaskSpecV2({ ...minimal(repo), providerRouting: routing })).rejects.toThrow("only supports fallbackPolicy='none'");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), providerRouting: { ...routing, provider: "openrouter", apiKey: "not-a-secret" } })).rejects.toThrow("credential-shaped field");
  });

  it.each(EXECUTION_PROFILES.filter((profile) => profile !== "custom"))("normalizes the %s execution agreement profile", async (profile) => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), executionAgreement: { schemaVersion: 1, profile } }))
      .resolves.toMatchObject({ executionAgreement: { schemaVersion: 1, profile } });
  });

  it("normalizes custom phase ownership in canonical phase order", async () => {
    const repo = await gitRepo();
    const value = {
      ...minimal(repo),
      executionAgreement: {
        schemaVersion: 1, profile: "custom",
        phaseOwnership: { secretUse: "nobody", localValidation: "external_session", deploy: "nobody", taskAnalysis: "runforge" }
      }
    };
    const spec = await normalizeTaskSpecV2(value);
    expect(spec.executionAgreement).toEqual({
      schemaVersion: 1, profile: "custom",
      phaseOwnership: { taskAnalysis: "runforge", localValidation: "external_session", deploy: "nobody", secretUse: "nobody" }
    });
    expect(Object.keys(spec.executionAgreement.phaseOwnership ?? {})).toEqual(EXECUTION_PHASE_IDS.filter((phase) => ["taskAnalysis", "localValidation", "deploy", "secretUse"].includes(phase)));
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(taskSpecV2Schema);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects unknown custom phase ownership parties", async () => {
    const repo = await gitRepo();
    const value = {
      ...minimal(repo),
      executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: { deploy: "unknown_party" } }
    };
    await expect(normalizeTaskSpecV2(value)).rejects.toThrow("executionAgreement.phaseOwnership.deploy must be one of");
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(taskSpecV2Schema);
    expect(validate(value)).toBe(false);
  });

  it("rejects agreement version mismatch and ambiguous custom ownership", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), executionAgreement: { schemaVersion: 2, profile: "assist-only" } }))
      .rejects.toThrow("Unsupported executionAgreement.schemaVersion");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), executionAgreement: { schemaVersion: 1, profile: "custom" } }))
      .rejects.toThrow("requires a non-empty phaseOwnership");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), executionAgreement: { schemaVersion: 1, profile: "custom", phaseOwnership: {} } }))
      .rejects.toThrow("requires a non-empty phaseOwnership");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), executionAgreement: { schemaVersion: 1, profile: "local-ready", phaseOwnership: { implementation: "runforge" } } }))
      .rejects.toThrow("only valid when profile='custom'");
  });

  it.each([
    ["inspection", "assist-only"], ["validation", "assist-only"],
    ["implementation", "local-ready"], ["repair", "local-ready"]
  ] as const)("migrates an old %s TaskSpec to %s", async (mode, profile) => {
    const repo = await gitRepo();
    const value = { ...minimal(repo), execution: { mode } } as Record<string, any>;
    if (mode === "implementation" || mode === "repair") value.authority = { profile: "bounded-implementation" };
    await expect(normalizeTaskSpecV2(value)).resolves.toMatchObject({ executionAgreement: { schemaVersion: 1, profile } });
  });

  it("keeps the public and file schemas aligned and publishes an agreement example", async () => {
    const fileSchema = JSON.parse(await readFile("schemas/task-spec-v2.schema.json", "utf8"));
    expect(taskSpecV2Schema).toEqual(fileSchema);
    const contract = publicTaskSpecContract() as Record<string, any>;
    expect(contract.executionAgreement).toMatchObject({ schemaVersion: 1, profiles: EXECUTION_PROFILES, phases: EXECUTION_PHASE_IDS, phaseOwnershipParties: EXECUTION_PARTIES });
    expect(contract.validationContract).toMatchObject({
      preflightSchemaVersion: 1,
      autoDiscoveryDefaults: { acceptance: "required", evidenceRole: "product-validation", unknownCommands: "capability_unsupported_until_explicitly_described" },
      lanes: { product: ["docker-validation", "local-disposable-validation"], gitEvidence: "git-evidence" },
      gitEvidence: { binding: ["canonicalRepositoryIdentity", "expectedTargetSha"], execution: "argv-only", network: false, mutations: false },
    });
    expect(contract.implementationRequest.taskSpec.executionAgreement).toEqual({ schemaVersion: 1, profile: "local-ready" });
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(fileSchema);
    expect(validate(contract.implementationRequest.taskSpec), JSON.stringify(validate.errors)).toBe(true);
  });

  it("defaults omitted implementation runtime to the compatible public runtime id", async () => {
    const repo = await gitRepo();
    const implementation = {
      ...minimal(repo),
      execution: { mode: "implementation" },
      authority: { profile: "bounded-implementation", allowProviderCalls: true, allowNetwork: true },
      runtime: { externalNetwork: "allowed" }
    };
    await expect(normalizeTaskSpecV2(implementation)).resolves.toMatchObject({ runtime: { preference: "local-disposable" } });
    await expect(normalizeTaskSpecV2({ ...implementation, runtime: { ...implementation.runtime, preference: "docker" } }))
      .rejects.toThrow("incompatible with local-coding-agent; supported: local-disposable");
  });

  it.each([
    [{ ...minimal("/missing"), schemaVersion: 1 }, "Unsupported TaskSpec schemaVersion"],
    [{ ...minimal("/missing"), surprise: true }, "unknown field"],
    [{ ...minimal("/missing"), taskId: "x" }, "taskId must be"],
    [{ ...minimal("/missing"), target: { repository: "/definitely/missing" } }, "does not exist"]
  ])("rejects invalid contracts", async (value, message) => {
    await expect(normalizeTaskSpecV2(value)).rejects.toThrow(message);
  });

  it("rejects output inside target and unsafe shell commands while deferring Git to capability preflight", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), artifacts: { root: join(repo, "artifacts") } })).rejects.toThrow("outside target.repository");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), validation: { mode: "explicit", commands: ["git push origin main"] } })).resolves.toMatchObject({ validation: { requirements: [{ acceptance: "evidence-only" }] } });
    await expect(normalizeTaskSpecV2({ ...minimal(repo), validation: { mode: "explicit", commands: ["rg credentials src"] } })).resolves.toBeDefined();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), validation: { mode: "explicit", commands: ["echo $API_KEY"] } })).rejects.toThrow("environment credentials");
  });

  it("reports malformed JSON clearly", async () => {
    const dir = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-spec-"))) - 1]!;
    const path = join(dir, "bad.json");
    await writeFile(path, "{nope");
    await expect(loadTaskSpecV2(path)).rejects.toThrow("Unable to read valid TaskSpec JSON");
  });

  it.each([
    "Use password=hunter2 for the check",
    "Call with Bearer abcdefghijklmnop",
    "Use https://build-user:private-value@example.test/path",
    "Token ghp_abcdefghijklmnopqrstuvwxyz"
  ])("rejects credential-like material before artifacts are written", async (text) => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), task: { text, goal: "Evidence", acceptanceCriteria: ["Checks run"] } }))
      .rejects.toThrow("credential-like material");
  });

  it("rejects publication that has no bounded repair", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({
      ...minimal(repo),
      execution: { mode: "implementation" },
      authority: { profile: "bounded-implementation", envelopeFile: "/tmp/authority.json", allowProviderCalls: false },
      git: { publication: "draft-pr", branch: "codex/test" }
    })).rejects.toThrow("Draft PR publication requires a bounded repair task");
  });

  it("enforces project-specific forbidden repair paths", async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "private.ts"), "export const value = 1;\n");
    const plan = join(repo, "repair.json");
    await writeFile(plan, JSON.stringify({ schema_version: "runforge.code-repair.v1", candidate_id: "TEST", task: "Change value", allowed_files: ["src/private.ts"], max_changed_files: 1, validation_commands: ["npm test"], changes: [{ file: "src/private.ts", replacements: [{ find: "1", replace: "2" }] }] }));
    await expect(normalizeTaskSpecV2({
      ...minimal(repo), runtime: { preference: "local-disposable", prepareDependencies: true },
      execution: { mode: "repair" },
      authority: { profile: "bounded-implementation", forbiddenAreas: ["src/private.ts"] }, repair: { mode: "code", plan }
    })).rejects.toThrow("forbidden by authority.forbiddenAreas");
  });

  it("rejects a branch when publication is disabled", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), git: { publication: "none", branch: "codex/not-created" } }))
      .rejects.toThrow("only valid when git.publication='draft-pr'");
  });

  it.each([
    { authority: { envelopeFile: "" } },
    { repair: { plan: "" } }
  ])("rejects empty optional file paths", async (override) => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), ...override })).rejects.toThrow("must be a non-empty string");
  });

  it("rejects unborn repositories but defers unavailable dependency preparation to execution", async () => {
    const unborn = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-unborn-spec-"))) - 1]!;
    await execFileAsync("git", ["init", "-b", "main", unborn]);
    await expect(normalizeTaskSpecV2(minimal(unborn))).rejects.toThrow("valid committed HEAD");

    const repo = await gitRepo();
    await rm(join(repo, "package-lock.json"));
    await expect(normalizeTaskSpecV2({ ...minimal(repo), runtime: { preference: "docker", prepareDependencies: true } }))
      .resolves.toMatchObject({ runtime: { dependencyPreparation: "required" } });
  });

  it("discovers a nested yarn application while preserving repository identity", async () => {
    const repo = await gitRepo();
    await rm(join(repo, "package.json")); await rm(join(repo, "package-lock.json"));
    await mkdir(join(repo, "frontend"));
    await writeFile(join(repo, "frontend", "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "node -e \"\"" } }));
    await writeFile(join(repo, "frontend", "yarn.lock"), "# yarn\n");
    const spec = await normalizeTaskSpecV2({ ...minimal(repo), target: { repository: repo, workingDirectory: "frontend" } });
    expect(spec.target).toEqual({ repository: await realpath(repo), workingDirectory: "frontend", expectedSha: expect.any(String) });
    expect(spec.validation.commands).toEqual(["corepack yarn run typecheck", "corepack yarn test"]);
  });

  it("rejects invalid, traversing, and symlink-escaping execution roots", async () => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), target: { repository: repo, workingDirectory: "missing" } })).rejects.toThrow("existing directory");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), target: { repository: repo, workingDirectory: "../outside" } })).rejects.toThrow("path traversal");
    const outside = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-outside-"))) - 1]!;
    await symlink(outside, join(repo, "escaped"));
    await expect(normalizeTaskSpecV2({ ...minimal(repo), target: { repository: repo, workingDirectory: "escaped" } })).rejects.toThrow("escapes target.repository");
  });

  it.each(["required", "if-needed", "disabled", "reuse-existing"])("normalizes dependency strategy %s", async (strategy) => {
    const repo = await gitRepo();
    await expect(normalizeTaskSpecV2({ ...minimal(repo), runtime: { preference: "local-disposable", dependencyPreparation: strategy } }))
      .resolves.toMatchObject({ runtime: { preference: "local-disposable", dependencyPreparation: strategy } });
  });

  it("normalizes explicit validation capability metadata into TaskSpec", async () => {
    const repo = await gitRepo();
    const spec = await normalizeTaskSpecV2({
      ...minimal(repo),
      validation: {
        mode: "explicit", commands: ["custom-check"],
        requirements: [{ command: "custom-check", capabilities: ["shell", "database"], acceptance: "optional", evidenceRole: "integration-evidence", fallbacks: ["Use CI evidence"] }],
        projectPolicy: { deniedCapabilities: ["production"], skippedCommands: [] },
      },
    });
    expect(spec.validation).toMatchObject({
      mode: "explicit", commands: ["custom-check"],
      requirements: [{ command: "custom-check", requiredCapabilities: ["shell", "database"], acceptance: "optional", evidenceRole: "integration-evidence", fallbacks: ["Use CI evidence"], source: "explicit" }],
      projectPolicy: { deniedCapabilities: ["production"], skippedCommands: [] },
    });
  });

  it("preserves unsupported Git forms for capability preflight instead of shell execution", async () => {
    const repo = await gitRepo();
    const spec = await normalizeTaskSpecV2({ ...minimal(repo), validation: { mode: "explicit", commands: ["git fetch origin"] } });
    expect(spec.validation.requirements[0]).toMatchObject({ command: "git fetch origin", acceptance: "evidence-only", evidenceRole: "git-evidence" });
  });

  it("includes decisive post-apply stages in normalized validation", async () => {
    const root = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-stage-results-"))) - 1]!;
    for (const stage of ["baseline", "after-repair", "after-apply", "after-branch-apply", "after-commit", "after-push"]) {
      const dir = join(root, "validation", stage);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "results.json"), JSON.stringify([{ status: "passed", exitCode: 0, timedOut: false, artifactPaths: { commandLog: `${stage}.log` } }]));
    }
    const [result] = await readExternalValidationResults(root, ["npm test"]);
    expect(result).toMatchObject({ baseline: { status: "passed" }, afterApply: { status: "passed" }, afterBranchApply: { status: "passed" }, afterCommit: { status: "passed" }, afterPush: { status: "passed" } });
  });

  it("refuses to delete a pre-existing unrelated artifact directory", async () => {
    const repo = await gitRepo();
    const occupied = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-occupied-"))) - 1]!;
    await writeFile(join(occupied, "keep.txt"), "preserve\n");
    await expect(normalizeTaskSpecV2({ ...minimal(repo), artifacts: { root: occupied } })).rejects.toThrow("Refusing to replace existing artifacts.root");
  });

  it("allows only an identical normalized TaskSpec to reuse an artifact root", async () => {
    const repo = await gitRepo();
    const parent = roots[roots.push(await mkdtemp(join(tmpdir(), "runforge-repeat-"))) - 1]!;
    const occupied = join(parent, "artifacts");
    const value = { ...minimal(repo), artifacts: { root: occupied } };
    const first = await normalizeTaskSpecV2(value);
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "task-spec.normalized.json"), JSON.stringify(first, null, 2) + "\n");
    await expect(normalizeTaskSpecV2(value)).resolves.toEqual(first);
    await expect(normalizeTaskSpecV2({
      ...value,
      task: { ...first.task, goal: "Different evidence" }
    })).rejects.toThrow("identical normalized TaskSpec");
  });
});

function minimal(repo: string): Record<string, unknown> {
  return { schemaVersion: 2, taskId: "TEST-TASK-1", task: { text: "Validate safely", goal: "Evidence", acceptanceCriteria: ["Checks run"] }, target: { repository: repo }, execution: { mode: "validation" } };
}

async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "runforge-spec-repo-")); roots.push(repo);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node -e \"\"" } }));
  await writeFile(join(repo, "package-lock.json"), "{}\n");
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return repo;
}
