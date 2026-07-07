import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  acceptedDecisionForm,
  rejectedDecisionForm,
  renderApplyInstructions,
  renderHandoffReadme,
  renderRollbackInstructions,
  renderValidationInstructions
} from "./external-operator-handoff-renderer.js";
export { renderOperatorHandoffSummary } from "./external-operator-handoff-renderer.js";
export { validateOperatorHandoffPacket } from "./external-operator-handoff-validator.js";
import { validateOperatorHandoffPacket } from "./external-operator-handoff-validator.js";
import { readPacketValidationState } from "./operator-decision-summary.js";

type JsonObject = Record<string, unknown>;

export interface OperatorHandoffOptions {
  trial: string;
  out: string;
  operatorWorktree?: string;
  validationCommand?: string;
  trialId?: string;
}

export interface OperatorHandoffResult {
  trialId: string;
  handoffDir: string;
  readmePath: string;
  handoffJsonPath: string;
  proposalPatchPath: string;
  validation: OperatorHandoffValidationResult;
}

export interface OperatorHandoffValidationResult {
  passed: boolean;
  errors: string[];
}

export interface OperatorHandoffPacket {
  schemaVersion: "alpha-24-operator-handoff";
  trialId: string;
  generatedAt: string;
  sourceRepo: {
    path: string;
    headBefore: string | null;
    headAfter: string | null;
    statusBefore: string;
    statusAfter: string;
    originalRepoMutated: false;
    mutationVerdict: string;
  };
  worktree: {
    path: string;
    type: "disposable_operator_worktree";
  };
  failure: {
    command: string;
    status: "failed";
    summary: string;
  };
  proposal: {
    outcome: string;
    patchPath: string;
    autoAppliedByRunForge: false;
    operatorReviewRequired: true;
  };
  manualApply: {
    allowedTarget: "disposable_operator_worktree";
    forbiddenTarget: "original_repo";
    instructionsPath: "apply-instructions.md";
  };
  validation: {
    command: string;
    instructionsPath: "validation.md";
  };
  rollback: {
    instructionsPath: "rollback.md";
  };
  decisionForms: {
    accepted: "decision-form.accepted.json";
    rejected: "decision-form.rejected.json";
  };
  safety: {
    providerUsed: false;
    networkUsed: false;
    dbUsed: false;
    deployUsed: false;
    pushUsed: false;
    mergeUsed: false;
  };
  evidence: {
    packetPath: string;
    operatorSummaryPath: string;
    lifecycleReportPath: string;
    evidenceLinksPath: "evidence-links.json";
  };
}

interface TrialContext {
  trialRoot: string;
  proposalPacket: string;
  sourceRepo: string;
  originalRepo: string;
  operatorWorktree: string;
  proposalPatch: string;
  validationCommand: string;
  trialId: string;
  sourceHeadBefore: string | null;
  sourceHeadAfter: string | null;
  sourceStatusBefore: string;
  sourceStatusAfter: string;
  originalRepoMutated: false;
  originalMutationVerdict: string;
  proposalOutcome: string;
  failureSummary: string;
  operatorSummaryPath: string;
  lifecycleReportPath: string;
}

export async function generateOperatorHandoffPacket(options: OperatorHandoffOptions): Promise<OperatorHandoffResult> {
  const context = await resolveTrialContext(options);
  const handoffDir = resolve(options.out);
  await mkdir(handoffDir, { recursive: true });

  const proposalPatchPath = join(handoffDir, "proposal.patch");
  await copyFile(context.proposalPatch, proposalPatchPath);

  const handoff: OperatorHandoffPacket = {
    schemaVersion: "alpha-24-operator-handoff",
    trialId: context.trialId,
    generatedAt: new Date().toISOString(),
    sourceRepo: {
      path: context.originalRepo,
      headBefore: context.sourceHeadBefore,
      headAfter: context.sourceHeadAfter,
      statusBefore: context.sourceStatusBefore,
      statusAfter: context.sourceStatusAfter,
      originalRepoMutated: false,
      mutationVerdict: context.originalMutationVerdict
    },
    worktree: {
      path: context.operatorWorktree,
      type: "disposable_operator_worktree"
    },
    failure: {
      command: context.validationCommand,
      status: "failed",
      summary: context.failureSummary
    },
    proposal: {
      outcome: context.proposalOutcome,
      patchPath: "proposal.patch",
      autoAppliedByRunForge: false,
      operatorReviewRequired: true
    },
    manualApply: {
      allowedTarget: "disposable_operator_worktree",
      forbiddenTarget: "original_repo",
      instructionsPath: "apply-instructions.md"
    },
    validation: {
      command: context.validationCommand,
      instructionsPath: "validation.md"
    },
    rollback: {
      instructionsPath: "rollback.md"
    },
    decisionForms: {
      accepted: "decision-form.accepted.json",
      rejected: "decision-form.rejected.json"
    },
    safety: {
      providerUsed: false,
      networkUsed: false,
      dbUsed: false,
      deployUsed: false,
      pushUsed: false,
      mergeUsed: false
    },
    evidence: {
      packetPath: context.proposalPacket,
      operatorSummaryPath: context.operatorSummaryPath,
      lifecycleReportPath: context.lifecycleReportPath,
      evidenceLinksPath: "evidence-links.json"
    }
  };

  await writeJson(join(handoffDir, "handoff.json"), handoff);
  await writeFile(join(handoffDir, "README.md"), renderHandoffReadme(handoff), "utf8");
  await writeFile(join(handoffDir, "apply-instructions.md"), renderApplyInstructions(handoff), "utf8");
  await writeFile(join(handoffDir, "validation.md"), renderValidationInstructions(handoff), "utf8");
  await writeFile(join(handoffDir, "rollback.md"), renderRollbackInstructions(handoff), "utf8");
  await writeJson(join(handoffDir, "decision-form.accepted.json"), acceptedDecisionForm(handoff));
  await writeJson(join(handoffDir, "decision-form.rejected.json"), rejectedDecisionForm(handoff));
  await writeJson(join(handoffDir, "evidence-links.json"), {
    schemaVersion: "alpha-24-handoff-evidence-links",
    trialId: handoff.trialId,
    handoffReadme: "README.md",
    handoffJson: "handoff.json",
    proposalPatch: "proposal.patch",
    proposalPacket: handoff.evidence.packetPath,
    operatorSummary: handoff.evidence.operatorSummaryPath,
    lifecycleReport: handoff.evidence.lifecycleReportPath,
    applyInstructions: handoff.manualApply.instructionsPath,
    validationInstructions: handoff.validation.instructionsPath,
    rollbackInstructions: handoff.rollback.instructionsPath,
    acceptedDecisionForm: handoff.decisionForms.accepted,
    rejectedDecisionForm: handoff.decisionForms.rejected
  });

  await writeJson(join(context.proposalPacket, "operator-handoff.json"), {
    schemaVersion: "alpha-24-operator-handoff-link",
    trialId: handoff.trialId,
    handoffDir,
    readmePath: join(handoffDir, "README.md"),
    handoffJsonPath: join(handoffDir, "handoff.json"),
    proposalPatchPath
  });
  await writeFile(join(context.proposalPacket, "operator-handoff.md"), [
    "# Operator Handoff Packet",
    "",
    `Handoff README: ${join(handoffDir, "README.md")}`,
    `Handoff JSON: ${join(handoffDir, "handoff.json")}`,
    "",
    "RunForge proposes only. Operator applies manually. Original repo must remain unchanged.",
    ""
  ].join("\n"), "utf8");

  const validation = await validateOperatorHandoffPacket(handoffDir);
  return {
    trialId: handoff.trialId,
    handoffDir,
    readmePath: join(handoffDir, "README.md"),
    handoffJsonPath: join(handoffDir, "handoff.json"),
    proposalPatchPath,
    validation
  };
}

async function resolveTrialContext(options: OperatorHandoffOptions): Promise<TrialContext> {
  const trialRoot = resolve(options.trial);
  const proposalPacket = await findProposalPacket(trialRoot);
  const realRepoTrial = await readOptionalJson<JsonObject>(join(proposalPacket, "real-repo-trial.json"));
  const run = await readOptionalJson<JsonObject>(join(proposalPacket, "run.json"));
  const proposalStatus = await readOptionalJson<JsonObject>(join(proposalPacket, "proposal-status.json"));
  const validation = await readPacketValidationState(proposalPacket);
  const sourceRepo = stringValue(realRepoTrial?.disposableSourceRepo) || stringValue(objectValue(run?.repo)?.path) || trialRoot;
  const originalRepo = stringValue(realRepoTrial?.originalRepo) || sourceRepo;
  const originalBefore = objectValue(realRepoTrial?.originalRepoBefore);
  const originalAfter = objectValue(realRepoTrial?.originalRepoAfter);
  const operatorWorktree = resolve(options.operatorWorktree ?? join(trialRoot, "operator-worktree"));
  const validationCommand = options.validationCommand ?? (stringValue(realRepoTrial?.validationCommand) || validation.beforeCommand);
  const trialId = options.trialId ?? (stringValue(proposalStatus?.runId) || stringValue(run?.runId) || basename(trialRoot));
  const proposalPatch = join(proposalPacket, "proposal.patch");
  await access(proposalPatch);
  return {
    trialRoot,
    proposalPacket,
    sourceRepo,
    originalRepo,
    operatorWorktree,
    proposalPatch,
    validationCommand,
    trialId,
    sourceHeadBefore: stringValue(originalBefore?.head) || stringValue(objectValue(run?.repo)?.headBefore) || null,
    sourceHeadAfter: stringValue(originalAfter?.head) || stringValue(objectValue(run?.repo)?.headAfter) || null,
    sourceStatusBefore: stringValue(originalBefore?.status),
    sourceStatusAfter: stringValue(originalAfter?.status),
    originalRepoMutated: false,
    originalMutationVerdict: stringValue(realRepoTrial?.originalRepoMutationVerdict) || stringValue(objectValue(run?.repo)?.mutationVerdict) || "unchanged",
    proposalOutcome: stringValue(proposalStatus?.outcome) || "unknown",
    failureSummary: validation.before === "failed" ? `Validation command failed before the proposal: ${validationCommand}.` : `Failure evidence recorded for command: ${validationCommand}.`,
    operatorSummaryPath: join(proposalPacket, "operator-summary.md"),
    lifecycleReportPath: join(trialRoot, "lifecycle-report.json")
  };
}

async function findProposalPacket(trialRoot: string): Promise<string> {
  const direct = join(trialRoot, "packet");
  if (await exists(join(direct, "proposal.patch"))) return direct;
  const proposalRun = join(trialRoot, "proposal-run", "packet");
  if (await exists(join(proposalRun, "proposal.patch"))) return proposalRun;
  throw new Error(`Unable to find proposal packet under ${trialRoot}`);
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
