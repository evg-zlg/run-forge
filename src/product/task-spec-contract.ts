import { EXECUTION_PARTIES, EXECUTION_PHASE_IDS, EXECUTION_PROFILES } from "./execution-agreement.js";

export const taskSpecSchemaVersion = 2 as const;
export const taskSpecSchemaPath = "/schemas/task-spec-v2.schema.json" as const;
export const taskExecutionModes = ["inspection", "implementation", "validation", "repair"] as const;
export type TaskExecutionMode = typeof taskExecutionModes[number];

export const taskRuntimeIds = ["docker", "local-disposable"] as const;
export type TaskRuntimeId = typeof taskRuntimeIds[number];

export const implementationExecutorContract = {
  id: "local-coding-agent",
  modes: ["implementation", "repair"] as const,
  runtimes: ["local-disposable"] as const,
  defaultRuntime: "local-disposable" as const,
  maxLimits: { timeoutMs: 1_800_000, repairIterations: 3, changedFiles: 100, patchBytes: 5_000_000, providerTokens: 200_000 }
};

export function defaultRuntimeForMode(mode: TaskExecutionMode): TaskRuntimeId {
  return implementationExecutorContract.modes.includes(mode as "implementation" | "repair")
    ? implementationExecutorContract.defaultRuntime
    : "docker";
}

export function runtimeCompatibleWithImplementationExecutor(runtime: string): runtime is typeof implementationExecutorContract.runtimes[number] {
  return implementationExecutorContract.runtimes.includes(runtime as "local-disposable");
}

export const taskSpecV2Schema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://runforge.local/schemas/task-spec-v2.schema.json",
  title: "RunForge TaskSpec v2",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "taskId", "task", "target", "execution"],
  properties: {
    schemaVersion: { const: taskSpecSchemaVersion },
    taskId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$" },
    task: { type: "object", additionalProperties: false, required: ["text", "goal", "acceptanceCriteria"], properties: { text: { type: "string", minLength: 1 }, goal: { type: "string", minLength: 1 }, acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } },
    target: { type: "object", additionalProperties: false, required: ["repository"], properties: { repository: { type: "string", minLength: 1 }, workingDirectory: { type: "string", minLength: 1 }, expectedSha: { type: "string", minLength: 7 }, dirtyPolicy: { enum: ["require_clean", "allow_known_generated", "snapshot_from_sha", "use_disposable_from_base_sha"] } } },
    execution: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: taskExecutionModes }, maxRepairIterations: { type: "integer", minimum: 0, maximum: 3 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 }, maxChangedFiles: { type: "integer", minimum: 1, maximum: 100 }, maxPatchBytes: { type: "integer", minimum: 1000, maximum: 5000000 }, maxProviderTokens: { type: "integer", minimum: 1000, maximum: 200000 }, budgetMode: { enum: ["soft", "hard"] }, phaseBudgets: { type: "object", additionalProperties: false, properties: Object.fromEntries(["startup", "analysis", "implementation", "validation", "repair", "review", "publication"].map((phase) => [phase, { type: "integer", minimum: 0, maximum: 200000 }])) } } },
    executionAgreement: {
      type: "object", additionalProperties: false, required: ["schemaVersion", "profile"],
      properties: {
        schemaVersion: { const: 1 }, profile: { enum: EXECUTION_PROFILES },
        phaseOwnership: {
          type: "object", minProperties: 1, additionalProperties: false,
          properties: Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, { enum: EXECUTION_PARTIES }]))
        }
      },
      allOf: [{ if: { properties: { profile: { const: "custom" } } }, then: { required: ["phaseOwnership"] }, else: { not: { required: ["phaseOwnership"] } } }]
    },
    discovery: { type: "object", additionalProperties: false, properties: { policy: { enum: ["auto", "explicit"] }, profile: { enum: ["small-scope", "standard"] }, explicitFiles: { type: "array", items: { type: "string", minLength: 1 } }, maxFiles: { type: "integer", minimum: 1, maximum: 1000 }, maxBytes: { type: "integer", minimum: 1000, maximum: 10000000 }, maxTokens: { type: "integer", minimum: 100, maximum: 500000 }, stopCondition: { type: "string", minLength: 1 } } },
    runtime: { type: "object", additionalProperties: false, properties: { preference: { enum: taskRuntimeIds }, dockerImage: { type: "string", minLength: 1 }, prepareDependencies: { type: "boolean" }, dependencyPreparation: { enum: ["required", "if-needed", "disabled", "reuse-existing"] }, externalNetwork: { enum: ["denied", "dependency-preparation-only", "allowed"] } }, not: { required: ["prepareDependencies", "dependencyPreparation"] } },
    validation: { type: "object", additionalProperties: false, properties: { mode: { enum: ["auto", "explicit"] }, commands: { type: "array", items: { type: "string", minLength: 1 } } } },
    authority: { type: "object", additionalProperties: false, properties: { profile: { enum: ["read-only", "bounded-implementation"] }, envelopeFile: { type: ["string", "null"] }, forbiddenAreas: { type: "array", items: { type: "string", minLength: 1 } }, allowProviderCalls: { type: "boolean" }, allowNetwork: { type: "boolean" } } },
    git: { type: "object", additionalProperties: false, properties: { publication: { enum: ["none", "draft-pr"] }, branch: { type: ["string", "null"] } } },
    merge: { type: "object", additionalProperties: false, properties: { policy: { const: "never" } } },
    deploy: { type: "object", additionalProperties: false, properties: { policy: { const: "never" } } },
    artifacts: { type: "object", additionalProperties: false, properties: { root: { type: "string", minLength: 1 }, resultFormat: { const: "normalized-v1" } } },
    ownerGate: { type: "object", additionalProperties: false, properties: { policy: { const: "stop-and-report" } } },
    repair: { type: "object", additionalProperties: false, properties: { mode: { enum: ["none", "disposable", "code"] }, plan: { type: ["string", "null"] } } }
  }
};

export function publicTaskSpecContract(): Record<string, unknown> {
  const executor = implementationExecutorContract;
  return {
    contractVersion: "task-spec-v2",
    schemaVersion: taskSpecSchemaVersion,
    schemaUrl: taskSpecSchemaPath,
    schema: taskSpecV2Schema,
    executionModes: taskExecutionModes,
    executionAgreement: { schemaVersion: 1, profiles: EXECUTION_PROFILES, phases: EXECUTION_PHASE_IDS, phaseOwnershipParties: EXECUTION_PARTIES },
    runtimeIds: taskRuntimeIds,
    runtimeDefaults: { implementation: executor.defaultRuntime, repair: executor.defaultRuntime, inspection: "docker", validation: "docker" },
    implementationExecutorIds: [executor.id],
    compatibleRuntimes: { [executor.id]: executor.runtimes },
    requiredImplementationAuthority: {
      taskSpec: ["authority.profile=bounded-implementation", "authority.allowProviderCalls=true", "authority.allowNetwork=true"],
      request: ["implementation=true", "providerCalls=true", "network=true", "localBranch=true", "localCommit=true"],
      publication: ["publication=none", "remotePush=false", "draftPublication=false", "merge=false", "deploy=false"]
    },
    implementationRequest: {
      projectId: "<registered-project-id>",
      taskSpec: {
        schemaVersion: taskSpecSchemaVersion,
        taskId: "IMPLEMENTATION-TASK-1",
        task: { text: "Fix the bounded defect and add a regression test.", goal: "Validation is green and a local commit is recorded.", acceptanceCriteria: ["Defect is fixed", "Regression test passes", "Local commit is recorded"] },
        target: { repository: "<registered-project-path>", workingDirectory: ".", dirtyPolicy: "use_disposable_from_base_sha" },
        execution: { mode: "implementation", maxRepairIterations: 2, timeoutMs: 300000, maxChangedFiles: 20, maxPatchBytes: 500000, maxProviderTokens: executor.maxLimits.providerTokens, budgetMode: "soft", phaseBudgets: { startup: 10000, analysis: 20000, implementation: 90000, validation: 20000, repair: 40000, review: 14000, publication: 6000 } },
        discovery: { policy: "auto", profile: "small-scope", explicitFiles: [], maxFiles: 20, maxBytes: 240000, maxTokens: 30000, stopCondition: "Stop when the bounded task and directly related policy/tests are sufficient." },
        executionAgreement: { schemaVersion: 1, profile: "local-ready" },
        runtime: { preference: executor.defaultRuntime, dependencyPreparation: "if-needed", externalNetwork: "allowed" },
        validation: { mode: "auto", commands: [] },
        authority: { profile: "bounded-implementation", forbiddenAreas: [".env", "secrets"], allowProviderCalls: true, allowNetwork: true },
        git: { publication: "none", branch: null },
        merge: { policy: "never" },
        deploy: { policy: "never" },
        repair: { mode: "none", plan: null }
      },
      authority: { inspect: true, implementation: true, providerCalls: true, network: true, localBranch: true, localCommit: true, remotePush: false, draftPublication: false, merge: false, deploy: false },
      publication: "none"
    }
  };
}
