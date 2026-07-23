import type { DurableCheckpointInput } from "./durable-checkpoint-types.js";

type PortableContextInput = {
  projectId: string;
  taskSpec: unknown;
  executionAgreementId: string;
  executionAgreement: unknown;
  authoritySnapshot: unknown;
  validationPlan: unknown;
  completedEvidence: unknown[];
  validationPassed: boolean;
  iteration: number;
  providerAccounting: unknown;
  providerCalls: number;
  providerTokens: number;
};

type PortableContext = Pick<
  DurableCheckpointInput,
  "projectId" | "taskSpec" | "executionAgreement" | "authoritySnapshot" | "validationPlan" |
  "completedEvidence" | "pendingPhases" | "providerUsage"
>;

export function durableCheckpointContext(input: PortableContextInput): PortableContext {
  const phaseUsage = { accounting: input.providerAccounting, calls: input.providerCalls, tokens: input.providerTokens };
  return {
    projectId: input.projectId,
    taskSpec: input.taskSpec,
    executionAgreement: { id: input.executionAgreementId, ...(input.executionAgreement as Record<string, unknown>) },
    authoritySnapshot: input.authoritySnapshot,
    validationPlan: input.validationPlan,
    completedEvidence: input.completedEvidence,
    pendingPhases: input.validationPassed
      ? ["independent_review", "publication"]
      : ["candidate_validation", "independent_review", "publication"],
    providerUsage: {
      implementation: input.iteration === 0 ? phaseUsage : null,
      repair: input.iteration > 0 ? phaseUsage : null,
      validation: { providerCalls: 0 },
      review: { providerCalls: 0 },
    },
  };
}
