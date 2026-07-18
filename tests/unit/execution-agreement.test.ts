import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PARTIES, EXECUTION_PHASE_IDS, EXECUTION_PROFILES,
  completeExecutionPhase, negotiateExecutionAgreement, normalizeExecutionHandoff,
} from "../../src/product/execution-agreement.js";

const allTrue = Object.fromEntries(EXECUTION_PHASE_IDS.map((phase) => [phase, true]));

describe("Execution Agreement v1", () => {
  it("represents all phases and profiles individually and validates against the schema", async () => {
    expect(EXECUTION_PHASE_IDS).toHaveLength(22);
    expect(new Set(EXECUTION_PHASE_IDS).size).toBe(22);
    expect(EXECUTION_PARTIES).toEqual(["runforge", "external_session", "owner", "external_system", "nobody"]);
    expect(EXECUTION_PROFILES).toEqual(["assist-only", "local-ready", "draft-pr", "delivery", "custom"]);
    const agreement = negotiateExecutionAgreement({ profile: "delivery", technicalCapability: allTrue, authority: allTrue, policy: allTrue });
    expect(agreement.phases.map((phase) => phase.phaseId)).toEqual(EXECUTION_PHASE_IDS);
    const schema = JSON.parse(await readFile("schemas/execution-agreement-v1.schema.json", "utf8"));
    expect(new Ajv2020({ strict: true }).compile(schema)(agreement)).toBe(true);
  });

  it("keeps capability, authority, request, responsibility, and policy distinct", () => {
    const agreement = negotiateExecutionAgreement({
      profile: "custom",
      requested: { implementation: true, localValidation: false },
      requestedOwnership: { implementation: "runforge", localValidation: "runforge" },
      technicalCapability: { implementation: true, localValidation: true },
      authority: { implementation: true, localValidation: true },
      policy: { implementation: false, localValidation: true },
    });
    expect(agreement.phases.find((phase) => phase.phaseId === "implementation")).toMatchObject({
      requested: true, available: true, authorized: true, policyAllowed: false,
      responsibleParty: "runforge", status: "conflict",
    });
    expect(agreement.phases.find((phase) => phase.phaseId === "localValidation")).toMatchObject({
      requested: false, available: true, authorized: true, policyAllowed: true,
      responsibleParty: "nobody", status: "not_requested",
    });
    expect(agreement.conflicts).toEqual([expect.objectContaining({ phaseId: "implementation", kind: "policy_denied" })]);
  });

  it("reports deterministic pre-execution conflicts for unavailable or unauthorized RunForge work", () => {
    const input = {
      profile: "custom" as const,
      requestedOwnership: { implementation: "runforge", localValidation: "runforge" } as const,
      technicalCapability: { implementation: false, localValidation: true },
      authority: { implementation: true, localValidation: false },
      policy: { implementation: true, localValidation: true },
    };
    const first = negotiateExecutionAgreement(input);
    const second = negotiateExecutionAgreement(input);
    expect(first.agreementId).toBe(second.agreementId);
    expect(first.status).toBe("conflicted");
    expect(first.conflicts.map(({ phaseId, kind }) => ({ phaseId, kind }))).toEqual([
      { phaseId: "implementation", kind: "unavailable" },
      { phaseId: "localValidation", kind: "unauthorized" },
    ]);
  });

  it("normalizes external delegation as a handoff rather than a failure", () => {
    const agreement = negotiateExecutionAgreement({
      profile: "custom",
      requestedOwnership: { merge: "owner", deploy: "external_system", postDeployValidation: "external_session" },
      prerequisites: { deploy: [" release approved ", "release approved", "CI green"] },
    });
    expect(agreement.status).toBe("ready");
    expect(agreement.conflicts).toEqual([]);
    expect(normalizeExecutionHandoff(agreement)).toEqual([
      expect.objectContaining({ phaseId: "merge", responsibleParty: "owner" }),
      expect.objectContaining({ phaseId: "deploy", responsibleParty: "external_system", prerequisites: ["CI green", "release approved"] }),
      expect.objectContaining({ phaseId: "postDeployValidation", responsibleParty: "external_session" }),
    ]);
    expect(agreement.humanSummary).toContain("deploy -> external_system");
  });

  it("records completion evidence immutably and produces a normalized completed agreement", () => {
    const initial = negotiateExecutionAgreement({
      profile: "custom", requestedOwnership: { taskAnalysis: "runforge" },
      technicalCapability: { taskAnalysis: true }, authority: { taskAnalysis: true }, policy: { taskAnalysis: true },
    });
    const completed = completeExecutionPhase(initial, "taskAnalysis", [" report.json ", "report.json"]);
    expect(initial.phases.find((phase) => phase.phaseId === "taskAnalysis")?.status).toBe("ready");
    expect(completed.phases.find((phase) => phase.phaseId === "taskAnalysis")).toMatchObject({ status: "completed", completionEvidence: ["report.json"] });
    expect(completed.status).toBe("completed");
    expect(completed.agreementId).not.toBe(initial.agreementId);
    expect(() => completeExecutionPhase(initial, "taskAnalysis", [])).toThrow("Completion evidence is required");
  });
});
