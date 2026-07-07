import { readFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface OperatorDecisionSummary {
  schemaVersion: "alpha-23-operator-decision-summary";
  trialId: string;
  repo: {
    sourcePath: string;
    sourceHeadBefore: string | null;
    sourceHeadAfter: string | null;
    sourceStatusBefore: string;
    sourceStatusAfter: string;
    originalRepoMutated: boolean;
  };
  proposal: {
    outcome: string;
    packetPath: string;
    patchPath: string;
    autoAppliedByRunForge: false;
    operatorReviewRequired: true;
  };
  decision: {
    verdict: string;
    appliedBy: string;
    appliedTo: string;
    reason: string;
    decisionPath: string;
  };
  validation: {
    before: string;
    after: string;
    beforeCommand: string;
    afterCommand: string;
  };
  safety: {
    providerUsed: false;
    networkUsed: false;
    dbUsed: false;
    deployUsed: false;
    pushUsed: false;
    mergeUsed: false;
  };
  nextAction: string;
}

export interface BuildOperatorDecisionSummaryInput {
  trialId: string;
  sourcePath: string;
  sourceHeadBefore?: string | null;
  sourceHeadAfter?: string | null;
  sourceStatusBefore?: string | null;
  sourceStatusAfter?: string | null;
  originalRepoMutated: boolean;
  proposalOutcome: string;
  proposalPacket: string;
  proposalPatch: string;
  decisionVerdict: string;
  appliedBy: string;
  appliedTo: string;
  reason?: string;
  decisionPath: string;
  validationBefore: string;
  validationAfter: string;
  beforeCommand: string;
  afterCommand: string;
  nextAction?: string;
}

export function buildOperatorDecisionSummary(input: BuildOperatorDecisionSummaryInput): OperatorDecisionSummary {
  return {
    schemaVersion: "alpha-23-operator-decision-summary",
    trialId: input.trialId,
    repo: {
      sourcePath: input.sourcePath,
      sourceHeadBefore: input.sourceHeadBefore ?? null,
      sourceHeadAfter: input.sourceHeadAfter ?? null,
      sourceStatusBefore: input.sourceStatusBefore ?? "",
      sourceStatusAfter: input.sourceStatusAfter ?? "",
      originalRepoMutated: input.originalRepoMutated
    },
    proposal: {
      outcome: input.proposalOutcome,
      packetPath: input.proposalPacket,
      patchPath: input.proposalPatch,
      autoAppliedByRunForge: false,
      operatorReviewRequired: true
    },
    decision: {
      verdict: input.decisionVerdict,
      appliedBy: input.appliedBy,
      appliedTo: input.appliedTo,
      reason: input.reason ?? "",
      decisionPath: input.decisionPath
    },
    validation: {
      before: input.validationBefore,
      after: input.validationAfter,
      beforeCommand: input.beforeCommand,
      afterCommand: input.afterCommand
    },
    safety: {
      providerUsed: false,
      networkUsed: false,
      dbUsed: false,
      deployUsed: false,
      pushUsed: false,
      mergeUsed: false
    },
    nextAction: input.nextAction ?? defaultNextAction(input.decisionVerdict)
  };
}

export function renderOperatorDecisionSummaryMarkdown(summary: OperatorDecisionSummary): string {
  return [
    "# Operator Patch Trial Summary",
    "",
    `Trial ID: ${summary.trialId}`,
    `Decision: ${summary.decision.verdict}`,
    `Next action: ${summary.nextAction}`,
    "",
    "## Failure",
    "",
    `- Before validation: ${summary.validation.before}`,
    `- Before command: ${summary.validation.beforeCommand}`,
    "",
    "## Proposal",
    "",
    `- Outcome: ${summary.proposal.outcome}`,
    `- Packet: ${summary.proposal.packetPath}`,
    `- Patch: ${summary.proposal.patchPath}`,
    `- RunForge auto-applied patch: ${summary.proposal.autoAppliedByRunForge}`,
    `- Operator review required: ${summary.proposal.operatorReviewRequired}`,
    "",
    "## Manual Apply Boundary",
    "",
    "RunForge proposes. The operator applies manually or via explicitly labelled operator simulation. The original repo stays unchanged.",
    "",
    "## Decision",
    "",
    `- Verdict: ${summary.decision.verdict}`,
    `- Applied by: ${summary.decision.appliedBy}`,
    `- Applied to: ${summary.decision.appliedTo}`,
    `- Reason: ${summary.decision.reason || "none"}`,
    `- Decision record: ${summary.decision.decisionPath}`,
    "",
    "## Validation",
    "",
    `- After validation: ${summary.validation.after}`,
    `- After command: ${summary.validation.afterCommand}`,
    "",
    "## Original Repo",
    "",
    `- Source path: ${summary.repo.sourcePath}`,
    `- HEAD before: ${summary.repo.sourceHeadBefore ?? "unknown"}`,
    `- HEAD after: ${summary.repo.sourceHeadAfter ?? "unknown"}`,
    `- Status before: ${summary.repo.sourceStatusBefore || "(clean)"}`,
    `- Status after: ${summary.repo.sourceStatusAfter || "(clean)"}`,
    `- Original repo mutated: ${summary.repo.originalRepoMutated}`,
    "",
    "## Safety Checklist",
    "",
    `- Provider used: ${summary.safety.providerUsed}`,
    `- Network used: ${summary.safety.networkUsed}`,
    `- DB used: ${summary.safety.dbUsed}`,
    `- Deploy used: ${summary.safety.deployUsed}`,
    `- Push used: ${summary.safety.pushUsed}`,
    `- Merge used: ${summary.safety.mergeUsed}`,
    ""
  ].join("\n");
}

export async function validateOperatorDecisionRecord(path: string): Promise<string[]> {
  const errors: string[] = [];
  let record: JsonObject;
  try {
    record = JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch {
    return [`operator-decision.json missing or invalid at ${path}`];
  }
  validateOperatorDecisionObject(record, errors);
  return errors;
}

export function validateOperatorDecisionObject(record: JsonObject, errors: string[] = []): string[] {
  const decision = stringValue(record.decision);
  const finalOutcome = stringValue(record.finalOutcome);
  const validation = objectValue(record.validation);
  const apply = objectValue(record.apply);
  const safety = objectValue(record.safety);
  const proposalPacket = stringValue(record.proposalPacket);
  const proposalPatch = stringValue(record.proposalPatch);
  const appliedTo = stringValue(apply?.appliedTo);
  const originalRepoMutated = apply?.originalRepoMutated;

  if (!proposalPacket) errors.push("operator-decision.json missing proposalPacket link");
  if (!proposalPatch) errors.push("operator-decision.json missing proposalPatch link");
  if (record.runforgeAppliedPatch !== false) errors.push("operator-decision.json missing runforgeAppliedPatch=false");
  if (!appliedTo) errors.push("operator-decision.json missing apply.appliedTo");
  if (appliedTo === "original_repo") errors.push("operator-decision.json apply.appliedTo must not be original_repo");
  if (!safety) errors.push("operator-decision.json missing safety summary");

  if ((decision === "accepted" || finalOutcome === "accepted") && originalRepoMutated === true) {
    errors.push("operator-decision.json accepted decision cannot have originalRepoMutated=true");
  }
  if (finalOutcome === "accepted") {
    if (validation?.passed === undefined) errors.push("operator-decision.json accepted decision missing after-validation result");
    if (validation?.passed !== true) errors.push("operator-decision.json accepted decision requires passed after-validation");
  }
  if (decision === "rejected" || finalOutcome === "rejected") {
    if (!stringValue(record.reason)) errors.push("operator-decision.json rejected decision requires reason");
  }
  return errors;
}

export async function readPacketValidationState(packetDir: string): Promise<{ before: string; after: string; beforeCommand: string; afterCommand: string; proposalOutcome: string }> {
  const beforeResults = await readOptionalJson(join(packetDir, "before-command-results.json"));
  const afterResults = await readOptionalJson(join(packetDir, "after-command-results.json"));
  const proposalStatus = await readOptionalJson(join(packetDir, "proposal-status.json"));
  return {
    before: commandsPassed(beforeResults) ? "passed" : "failed",
    after: commandsPassed(afterResults) ? "passed" : "failed",
    beforeCommand: firstCommand(beforeResults),
    afterCommand: firstCommand(afterResults),
    proposalOutcome: stringValue(proposalStatus?.outcome) || "unknown"
  };
}

function commandsPassed(value: JsonObject | null): boolean {
  const commands = Array.isArray(value?.commands) ? value.commands as JsonObject[] : [];
  return commands.length > 0 && commands.every((command) => command.status === "passed");
}

function firstCommand(value: JsonObject | null): string {
  const commands = Array.isArray(value?.commands) ? value.commands as JsonObject[] : [];
  return stringValue(commands[0]?.command) || "unknown";
}

async function readOptionalJson(path: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function defaultNextAction(verdict: string): string {
  if (verdict === "accepted") return "Review evidence, then decide outside RunForge whether to manually port the patch to a protected repo.";
  if (verdict === "rejected") return "Keep the original repo unchanged and gather more context or revise the proposal.";
  return "Review the decision record before taking manual action.";
}
