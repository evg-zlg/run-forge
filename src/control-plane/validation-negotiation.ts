import type { ExecutionAgreement, ExecutionParty } from "../product/execution-agreement.js";
import type { TaskSpecV2 } from "../product/task-spec-v2.js";
import type { ValidationAcceptance, ValidationCapability } from "../validation/capability-contract.js";
import { parseGitEvidenceCommand } from "../validation/git-evidence-lane.js";
import { ControlPlaneError } from "./contracts.js";

export type ValidationNegotiationDecision = {
  command: string;
  acceptance: ValidationAcceptance;
  requiredCapabilities: ValidationCapability[];
  disposition: "execute" | "deferred_preflight" | "capability_unsupported" | "skipped_by_policy";
  staticallyUnsupportedCapabilities: ValidationCapability[];
  reason: string;
  fallbacks: string[];
  blocking: boolean;
};

export type ValidationCapabilityNegotiation = {
  schemaVersion: 1;
  status: "accepted" | "rejected";
  stage: "task_acceptance";
  runtime: string;
  requirements: ValidationNegotiationDecision[];
  requiredUnsupported: Array<{ command: string; reason: string; fallbacks: string[] }>;
  responsibility: {
    executionAgreementId: string;
    structuralReview: { kind: "structural"; responsibleParty: ExecutionParty; source: "localValidation" };
    semanticReview: { kind: "semantic"; responsibleParty: ExecutionParty; source: "independentReview" };
  };
};

const deferredCapabilities = new Set<ValidationCapability>([
  "filesystem", "shell", "package-manager", "dependencies", "git-metadata", "git-history",
  "working-tree-index", "git-read-only-evidence",
]);
const unavailableLanes = new Set<ValidationCapability>(["credentials", "database", "production"]);

/** Negotiates only facts stable before a disposable workspace or provider invocation exists. */
export function negotiateValidationCapabilities(spec: TaskSpecV2, agreement: ExecutionAgreement): ValidationCapabilityNegotiation {
  const denied = new Set(spec.validation.projectPolicy.deniedCapabilities);
  const skipped = new Set(spec.validation.projectPolicy.skippedCommands);
  const requirements = spec.validation.requirements.map((requirement): ValidationNegotiationDecision => {
    const policyBlocked = skipped.has(requirement.command) || requirement.requiredCapabilities.some((capability) => denied.has(capability));
    const staticallyUnsupported = requirement.requiredCapabilities.filter((capability) => isStaticallyUnsupported(capability, spec));
    let staticReason: string | null = null;
    if (/^git(?:\s|$)/.test(requirement.command.trim())) {
      const parsed = parseGitEvidenceCommand(requirement.command, spec.target.expectedSha);
      if (!parsed.supported) staticReason = parsed.reason;
    }
    const unsupported = staticallyUnsupported.length > 0 || staticReason !== null;
    const hasDeferred = requirement.requiredCapabilities.some((capability) => deferredCapabilities.has(capability));
    const disposition = policyBlocked ? "skipped_by_policy" as const
      : unsupported ? "capability_unsupported" as const
        : hasDeferred ? "deferred_preflight" as const : "execute" as const;
    const reason = policyBlocked ? "Project policy skips this command or denies one of its capabilities."
      : staticReason ?? (staticallyUnsupported.length
        ? `No accepted ${spec.runtime.preference} validation lane can provide: ${staticallyUnsupported.join(", ")}.`
        : hasDeferred ? "Accepted; executable/package/Git evidence is verified again in runtime preflight before command execution."
          : "Accepted from statically available capability and authority facts.");
    return {
      command: requirement.command,
      acceptance: requirement.acceptance,
      requiredCapabilities: requirement.requiredCapabilities,
      disposition,
      staticallyUnsupportedCapabilities: staticallyUnsupported,
      reason,
      fallbacks: requirement.fallbacks,
      blocking: requirement.acceptance === "required" && (policyBlocked || unsupported),
    };
  });
  const requiredUnsupported = requirements.filter((item) => item.blocking).map(({ command, reason, fallbacks }) => ({ command, reason, fallbacks }));
  return {
    schemaVersion: 1,
    status: requiredUnsupported.length ? "rejected" : "accepted",
    stage: "task_acceptance",
    runtime: spec.runtime.preference,
    requirements,
    requiredUnsupported,
    responsibility: {
      executionAgreementId: agreement.agreementId,
      structuralReview: { kind: "structural", responsibleParty: phaseOwner(agreement, "localValidation"), source: "localValidation" },
      semanticReview: { kind: "semantic", responsibleParty: phaseOwner(agreement, "independentReview"), source: "independentReview" },
    },
  };
}

export function acceptValidationCapabilities(spec: TaskSpecV2, agreement: ExecutionAgreement, taskId: string): ValidationCapabilityNegotiation {
  const negotiation = negotiateValidationCapabilities(spec, agreement);
  if (negotiation.status === "rejected") throw new ControlPlaneError(422, "validation_capability_unavailable", "A required validation requirement is statically impossible; the task was not started and no provider was invoked.", {
    negotiation, operation: "start_new_task", newTaskRequired: true, nextResponsibleParty: "external_session",
    exactNextAction: "Change the required capability, runtime, policy, or acceptance level; or declare a truthful executable fallback and submit a new task ID."
  }, false, taskId);
  return negotiation;
}

function isStaticallyUnsupported(capability: ValidationCapability, spec: TaskSpecV2): boolean {
  if (unavailableLanes.has(capability)) return true;
  if (capability === "network") return !spec.authority.allowNetwork || spec.runtime.externalNetwork !== "allowed";
  if (capability === "provider-model") return !spec.authority.allowProviderCalls;
  if (capability === "docker") return spec.runtime.preference !== "docker";
  if (capability === "local-disposable") return spec.runtime.preference !== "local-disposable";
  return false;
}

function phaseOwner(agreement: ExecutionAgreement, phaseId: "localValidation" | "independentReview"): ExecutionParty {
  return agreement.phases.find((phase) => phase.phaseId === phaseId && phase.requested)?.responsibleParty ?? "nobody";
}
