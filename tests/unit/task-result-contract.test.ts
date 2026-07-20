import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { completeExecutionPhase, negotiateExecutionAgreement, type ExecutionAgreement } from "../../src/product/execution-agreement.js";
import {
  RUNFORGE_COMPLETION_STATUSES,
  buildAgreementAwareTaskResult,
  buildAgreementResultSummary,
  buildNormalizedHandoffPackage,
  buildResultNextAction,
  completionStatusForAgreement,
  completionStatusForIntent,
  externalResultContract,
  validateTaskResultContract,
} from "../../src/product/task-result-contract.js";
import { validateTaskResultContract as validateTaskResultContractDirect } from "../../src/product/task-result-validation.js";
import type { ExternalExecutionResult } from "../../src/run/external-execution.js";

describe("agreement-aware task result contract", () => {
  it("preserves the public validator import path", () => {
    expect(validateTaskResultContract).toBe(validateTaskResultContractDirect);
  });

  it("defines only the terminal completion statuses", () => {
    expect(RUNFORGE_COMPLETION_STATUSES).toEqual([
      "runforge_scope_completed", "workflow_completed", "awaiting_external_session", "awaiting_owner",
      "blocked_by_capability", "blocked_by_policy", "failed",
    ]);
    expect(completionStatusForIntent({ executionStatus: "completed", implementationExpected: true, targetChanged: true })).toBe("completed");
    expect(completionStatusForIntent({ executionStatus: "completed", implementationExpected: false, targetChanged: false })).toBe("completed");
    expect(completionStatusForIntent({ executionStatus: "completed", implementationExpected: true, targetChanged: false })).toBe("implementation_not_started");
    expect(completionStatusForIntent({ executionStatus: "awaiting_owner_decision", implementationExpected: true, targetChanged: false })).toBe("awaiting_owner_decision");
  });

  it("projects completed RunForge work and delegated work without classifying external phases as failures", () => {
    const agreement = partiallyCompletedAgreement();
    const summary = buildAgreementResultSummary(agreement);
    expect(completionStatusForAgreement(agreement)).toBe("awaiting_external_session");
    expect(summary).toMatchObject({
      profile: "custom",
      requestedProfile: "custom",
      effectiveProfile: "custom",
      status: "in_progress",
      phaseOwnership: [
        { phaseId: "taskAnalysis", responsibleParty: "runforge" },
        { phaseId: "implementation", responsibleParty: "external_session" },
        { phaseId: "merge", responsibleParty: "owner" },
      ],
      runforgeCompletedPhases: ["taskAnalysis"],
      delegatedPhases: [
        { phaseId: "implementation", responsibleParty: "external_session" },
        { phaseId: "merge", responsibleParty: "owner" },
      ],
      awaitingPhases: [
        { phaseId: "implementation", responsibleParty: "external_session", prerequisites: ["approved plan"] },
        { phaseId: "merge", responsibleParty: "owner", prerequisites: ["CI green"] },
      ],
    });
  });

  it.each(["assist-only", "local-ready"] as const)("normalizes a complete %s handoff package", (profile) => {
    const branch = profile === "local-ready" ? "runforge/agreement-result-1" : null;
    expect(buildNormalizedHandoffPackage({
      profile,
      summary: "  Bounded implementation is ready. ",
      changedFiles: ["src/z.ts", " src/a.ts ", "src/z.ts"],
      patch: " patch.diff ",
      branch,
      commit: null,
      validation: [{ command: " pnpm test ", status: "passed", exitCode: 0, evidence: [" test.log ", "test.log"] }],
      findings: [" finding B ", "finding A"],
      risks: ["owner review remains"],
      nextActions: [{
        party: "external_session",
        exactAction: " Apply patch.diff in the target worktree. ",
        gates: [{ name: "Owner approval", status: "satisfied", evidence: ["decision.json"] }],
        evidence: [{ kind: "patch", reference: "patch.diff", summary: "Validated patch" }],
      }],
      publicationInstructions: ["Do not merge", " Open a draft PR "],
      ciCommands: ["pnpm test", "pnpm typecheck"],
      safety: { providerCalls: true, notes: ["No secrets accessed"] },
      targetSha: "def456",
      baseSha: "abc123",
    })).toEqual({
      profile,
      summary: "Bounded implementation is ready.",
      changedFiles: ["src/a.ts", "src/z.ts"],
      patch: "patch.diff",
      branch,
      commit: null,
      validation: [{ command: "pnpm test", status: "passed", exitCode: 0, evidence: ["test.log"] }],
      findings: ["finding A", "finding B"],
      risks: ["owner review remains"],
      nextActions: [{
        party: "external_session", exactAction: "Apply patch.diff in the target worktree.",
        gates: [{ name: "Owner approval", status: "satisfied", evidence: ["decision.json"] }],
        evidence: [{ kind: "patch", reference: "patch.diff", summary: "Validated patch" }],
      }],
      publicationInstructions: ["Do not merge", "Open a draft PR"],
      ciCommands: ["pnpm test", "pnpm typecheck"],
      safety: {
        targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false,
        databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: true,
        notes: ["No secrets accessed"],
      },
      targetSha: "def456",
      baseSha: "abc123",
    });
  });

  it("builds a reusable result and validates every status against the JSON schema", async () => {
    const result = buildAgreementAwareTaskResult({
      taskId: "AGREEMENT-RESULT-1",
      status: "awaiting_external_session",
      agreement: partiallyCompletedAgreement(),
      handoff: {
        profile: "assist-only", summary: "RunForge analysis is complete; implementation is delegated.",
        changedFiles: [], patch: null, branch: null, commit: null,
        validation: [{ command: "corepack pnpm run typecheck", status: "passed", exitCode: 0, evidence: ["validation/typecheck.log"] }],
        findings: ["Implementation plan prepared"], risks: ["Patch is not yet applied"],
        nextActions: [{ party: "external_session", exactAction: "Implement the approved plan, run validation, and attach the patch.", gates: [], evidence: [] }],
        publicationInstructions: ["Do not publish before local validation passes"],
        ciCommands: ["corepack pnpm run typecheck"],
        safety: { providerCalls: false, notes: ["No target mutation"] }, targetSha: "def456", baseSha: "abc123",
      },
      next: {
        party: "external_session", exactAction: "Implement the approved plan, run validation, and attach the patch.",
        gates: [{ name: "Approved plan", status: "satisfied", evidence: ["plan.md"] }],
        evidence: [{ kind: "artifact", reference: "plan.md", summary: "Approved bounded plan" }],
      },
    });
    validateTaskResultContract(result);
    const schema = JSON.parse(await readFile("schemas/task-result-v1.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    for (const status of RUNFORGE_COMPLETION_STATUSES) {
      expect(validate({ ...result, status }), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({ ...result, status: "completed" })).toBe(false);
    expect(result.agreement).toMatchObject({ profile: "custom", requestedProfile: "custom", effectiveProfile: "custom" });

    const oldAgreementAware = structuredClone(result) as unknown as Record<string, any>;
    delete oldAgreementAware.agreement.requestedProfile;
    delete oldAgreementAware.agreement.effectiveProfile;
    delete oldAgreementAware.handoff.branch;
    validateTaskResultContract(oldAgreementAware);
    expect(validate(oldAgreementAware), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects incomplete handoffs and unsafe claims", () => {
    const common = { profile: "local-ready" as const, summary: "Ready", changedFiles: [], patch: null, branch: "runforge/ready", commit: null, nextActions: [], targetSha: null, baseSha: null };
    expect(() => buildNormalizedHandoffPackage(common)).toThrow("at least one exact action");
    expect(() => buildNormalizedHandoffPackage({
      ...common,
      nextActions: [{ party: "owner", exactAction: "Review the patch" }],
      safety: { deploy: true } as never,
    })).toThrow("handoff.safety.deploy must be false");
    expect(() => buildResultNextAction({
      party: "owner", exactAction: "Review", gates: [{ name: "Review", status: "invalid" as never, evidence: [] }],
    })).toThrow("nextAction.gates[0].status is invalid");
    expect(() => buildNormalizedHandoffPackage({
      ...common,
      nextActions: [{ party: "owner", exactAction: "Review the patch" }],
      validation: [{ command: "pnpm test", status: "unknown" as never, exitCode: null }],
    })).toThrow("handoff.validation[0].status is invalid");
    expect(() => buildNormalizedHandoffPackage({
      ...common, branch: null, nextActions: [{ party: "owner", exactAction: "Review the patch" }],
    })).toThrow("handoff.branch is required for local-ready handoffs");
    expect(() => buildNormalizedHandoffPackage({
      ...common, profile: "assist-only", nextActions: [{ party: "owner", exactAction: "Review the patch" }],
    })).toThrow("handoff.branch must be null for assist-only handoffs");
  });

  it("keeps legacy result validation compatible while exposing capability and policy blocks to HTTP envelopes", async () => {
    const legacy = {
      schemaVersion: 1, contract: "runforge-task-result", taskId: "LEGACY-1", status: "completed",
      targetRepository: { path: "/repo", initialSha: "abc", finalSha: "def", changed: true },
      completedWork: [], validation: [], artifacts: { summary: "summary.md", results: "results.json" },
      ownerGate: { required: false, status: "not_required" }, nextAction: { recommendation: "Review results" },
      safetyAssertions: {
        targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false,
        databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false,
      },
      errors: [], limitations: [],
    };
    validateTaskResultContract(legacy);
    const schema = JSON.parse(await readFile("schemas/task-result-v1.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(legacy), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...legacy, status: "blocked_by_capability" })).toBe(true);
    expect(validate({ ...legacy, status: "blocked_by_policy" })).toBe(true);
    expect(validate({ ...legacy, status: "runforge_scope_completed" })).toBe(false);
  });

  it("rejects unsafe or inconsistent results identically at runtime and through AJV", async () => {
    const schema = JSON.parse(await readFile("schemas/task-result-v1.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const reject = (result: unknown) => {
      expect(() => validateTaskResultContract(result)).toThrow();
      expect(validate(result), JSON.stringify(validate.errors)).toBe(false);
    };

    const agreementCases: Array<(result: Record<string, any>) => void> = [
      (result) => { result.agreement.agreementId = "agreement-1"; },
      (result) => { result.agreement.phaseOwnership.push({ ...result.agreement.phaseOwnership[0] }); },
      (result) => { result.agreement.phaseOwnership[0].phaseId = "unknownPhase"; },
      (result) => { result.agreement.delegatedPhases.push({ ...result.agreement.delegatedPhases[0] }); },
      (result) => { result.agreement.awaitingPhases.push({ ...result.agreement.awaitingPhases[0], prerequisites: ["approved plan"] }); },
      (result) => { result.agreement.delegatedPhases[0].phaseId = "unknownPhase"; },
      (result) => { result.agreement.delegatedPhases[0].responsibleParty = "owner"; },
      (result) => { result.agreement.awaitingPhases[0].responsibleParty = "owner"; },
      (result) => { result.agreement.awaitingPhases[0].responsibleParty = "runforge"; },
      (result) => { result.agreement.awaitingPhases[0].responsibleParty = "nobody"; },
      (result) => { result.agreement.delegatedPhases = result.agreement.delegatedPhases.slice(1); },
      (result) => { result.agreement.runforgeCompletedPhases.push("implementation"); },
    ];
    for (const mutate of agreementCases) {
      const result = agreementAwareFixture() as unknown as Record<string, any>;
      mutate(result);
      reject(result);
    }

    const dangerousFields = ["targetMainMutation", "targetMainPush", "targetPrMerge", "deploy", "databaseAccess", "productionAccess", "secretAccess"];
    for (const field of dangerousFields) {
      const result = legacyFixture() as Record<string, any>;
      result.safetyAssertions[field] = true;
      reject(result);
    }

    for (const field of ["successNotInferred", "lateWorkerResultIgnored"]) {
      const result = failedSyntheticFixture() as Record<string, any>;
      result.safetyAssertions[field] = false;
      reject(result);
    }
    for (const [field, unsafeValue] of [["staleLeaseRevoked", false], ["lateWorkerResultIgnored", false], ["providerCallsInferred", true]] as const) {
      const result = interruptedSyntheticFixture() as Record<string, any>;
      result.safetyAssertions[field] = unsafeValue;
      reject(result);
    }
  });

  it.each([
    {
      schemaVersion: 1, taskId: "PUBLIC-FAILED-1", status: "failed", lastCompletedPhase: "validate", error: "worker failed",
      execution: { id: "execution-1", attempt: 1, operation: "execution" }, artifacts: { root: "/artifacts" },
      recovery: { reason: "worker_failed", retryAvailable: false, cleanupStatus: "completed" },
      safetyAssertions: { successNotInferred: true, lateWorkerResultIgnored: true },
      nextAction: "Inspect the failed attempt evidence and start a new task.",
    },
    {
      schemaVersion: 1, taskId: "PUBLIC-INTERRUPTED-1", status: "interrupted", lastCompletedPhase: "implement",
      interruption: { reason: "execution_deadline_exceeded", originalExecutionId: "execution-2" },
      execution: { id: "execution-2", attempt: 2, operation: "execution" }, targetMutation: { status: "not_inferred" },
      artifacts: { root: "/artifacts", created: [] }, validations: { incomplete: ["validation is green"] },
      recovery: { reason: "execution_deadline_exceeded", retryAvailable: true, cleanupStatus: "completed" },
      safetyAssertions: { staleLeaseRevoked: true, lateWorkerResultIgnored: true, attemptArtifactsIsolated: true, providerCallsInferred: false },
      nextAction: "/v1/tasks/PUBLIC-INTERRUPTED-1/retry",
    },
    {
      schemaVersion: 1, taskId: "PUBLIC-RESTART-INTERRUPTED-1", status: "interrupted", lastCompletedPhase: "unknown",
      interruption: { reason: "service_restart", originalExecutionId: "execution-3" }, targetMutation: { status: "not_inferred" },
      artifacts: { root: "/artifacts", created: [] }, validations: { incomplete: ["Execution did not reach a trusted terminal result."] },
      recovery: { reason: "service_restart", retryAvailable: true, cleanupStatus: "completed" },
      safetyAssertions: { staleLeaseRevoked: true, lateWorkerResultIgnored: true, providerCallsInferred: false },
    },
  ])("validates a synthetic public $status terminal result at runtime and against result v1", async (result) => {
    validateTaskResultContract(result);
    const schema = JSON.parse(await readFile("schemas/task-result-v1.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("legacy external result classification", () => {
  it.each(["failed", "committed-not-pushed", "pushed-no-pr"] as const)("classifies %s publication as a publication failure", (publication) => {
    const result = {
      runId: "PUBLICATION-FAILURE", source: { before: { path: "/repo", head: "abc", status: "" }, after: { path: "/repo", head: "abc", status: "" }, unchanged: true },
      runforgeCapability: "needs owner approval", factoryBaseline: "passed", disposableRepair: "patch-ready", ownerDecisionGate: "approved",
      controlledApply: "applied-to-controlled-worktree", prReadyPackage: "ready", authorityEnvelope: "accepted", patchPath: "patch.diff", controlledWorkspace: null, publication,
    } as unknown as ExternalExecutionResult;
    expect(externalResultContract({ taskId: "TASK" }, result, ["npm test"])).toMatchObject({
      status: "failed", ownerGate: { required: false, status: "not_available_failed_publication" },
      nextAction: { recommendation: expect.stringContaining("publication evidence") }, errors: [expect.stringContaining(publication)],
    });
  });
});

function partiallyCompletedAgreement(): ExecutionAgreement {
  const initial = negotiateExecutionAgreement({
    profile: "custom",
    requestedOwnership: { taskAnalysis: "runforge", implementation: "external_session", merge: "owner" },
    technicalCapability: { taskAnalysis: true }, authority: { taskAnalysis: true }, policy: { taskAnalysis: true },
    prerequisites: { implementation: ["approved plan"], merge: ["CI green"] },
  });
  return completeExecutionPhase(initial, "taskAnalysis", ["analysis.md"]);
}

function agreementAwareFixture() {
  const action = { party: "external_session" as const, exactAction: "Implement the approved plan.", gates: [], evidence: [] };
  return buildAgreementAwareTaskResult({
    taskId: "AGREEMENT-SAFETY-1", status: "awaiting_external_session", agreement: partiallyCompletedAgreement(),
    handoff: {
      profile: "assist-only", summary: "Analysis complete.", changedFiles: [], patch: null, branch: null, commit: null,
      nextActions: [action], safety: { providerCalls: false, notes: [] }, targetSha: null, baseSha: null,
    },
    next: action,
  });
}

function legacyFixture() {
  return {
    schemaVersion: 1, contract: "runforge-task-result", taskId: "LEGACY-SAFETY-1", status: "completed",
    targetRepository: { path: "/repo", initialSha: "abc", finalSha: "def", changed: true },
    completedWork: [], validation: [], artifacts: { summary: "summary.md", results: "results.json" },
    ownerGate: { required: false, status: "not_required" }, nextAction: { recommendation: "Review results" },
    safetyAssertions: {
      targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false,
      databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false,
    },
    errors: [], limitations: [],
  };
}

function failedSyntheticFixture() {
  return {
    schemaVersion: 1, taskId: "SYNTHETIC-FAILED-1", status: "failed", error: "worker failed",
    execution: {}, artifacts: {}, recovery: {}, nextAction: "Inspect evidence and retry.",
    safetyAssertions: { successNotInferred: true, lateWorkerResultIgnored: true },
  };
}

function interruptedSyntheticFixture() {
  return {
    schemaVersion: 1, taskId: "SYNTHETIC-INTERRUPTED-1", status: "interrupted",
    interruption: {}, targetMutation: {}, validations: {}, artifacts: {}, recovery: {},
    safetyAssertions: { staleLeaseRevoked: true, lateWorkerResultIgnored: true, providerCallsInferred: false },
  };
}
