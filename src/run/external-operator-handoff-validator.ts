import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OperatorHandoffValidationResult } from "./external-operator-handoff.js";

type JsonObject = Record<string, unknown>;

export async function validateOperatorHandoffPacket(handoffDir: string): Promise<OperatorHandoffValidationResult> {
  const root = resolve(handoffDir);
  const errors: string[] = [];
  for (const name of requiredFiles()) {
    await access(join(root, name)).catch(() => errors.push(`handoff packet missing ${name}`));
  }

  const handoff = await readOptionalJson<JsonObject>(join(root, "handoff.json"));
  if (!handoff) return { passed: false, errors };

  const proposal = objectValue(handoff.proposal);
  const manualApply = objectValue(handoff.manualApply);
  const validation = objectValue(handoff.validation);
  const sourceRepo = objectValue(handoff.sourceRepo);
  const rollback = objectValue(handoff.rollback);
  const decisionForms = objectValue(handoff.decisionForms);
  const safety = objectValue(handoff.safety);

  if (!stringValue(proposal?.patchPath)) errors.push("handoff.json missing proposal.patchPath");
  if (proposal?.autoAppliedByRunForge !== false) errors.push("handoff.json proposal.autoAppliedByRunForge must be false");
  if (proposal?.operatorReviewRequired !== true) errors.push("handoff.json proposal.operatorReviewRequired must be true");
  if (manualApply?.allowedTarget !== "disposable_operator_worktree") errors.push("handoff.json manualApply.allowedTarget must be disposable_operator_worktree");
  if (manualApply?.forbiddenTarget !== "original_repo") errors.push("handoff.json manualApply.forbiddenTarget must be original_repo");
  if (sourceRepo?.originalRepoMutated !== false) errors.push("handoff.json sourceRepo.originalRepoMutated must be false");
  if (!stringValue(validation?.command)) errors.push("handoff.json missing validation.command");
  if (!stringValue(rollback?.instructionsPath)) errors.push("handoff.json missing rollback instructions path");
  if (!stringValue(decisionForms?.accepted) || !stringValue(decisionForms?.rejected)) errors.push("handoff.json missing decision forms");
  for (const key of ["providerUsed", "networkUsed", "dbUsed", "deployUsed", "pushUsed", "mergeUsed"]) {
    if (safety?.[key] !== false) errors.push(`handoff.json safety.${key} must be false`);
  }

  const instructionText = await readInstructionText(root);
  if (/\b(?:git\s+push|git\s+merge|(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy|deploy\s+(?:--|\w))\b/i.test(instructionText)) {
    errors.push("handoff instructions must not include push, merge, or deploy commands");
  }
  if (!instructionText.includes("Original repo must remain unchanged")) errors.push("handoff instructions missing original repo unchanged warning");
  if (!instructionText.includes("RunForge proposes only")) errors.push("handoff instructions missing no-auto-apply statement");

  const accepted = await readOptionalJson<JsonObject>(join(root, "decision-form.accepted.json"));
  if (accepted?.decision !== "accepted") errors.push("accepted decision form missing decision=accepted");
  if (accepted?.appliedBy !== "operator_manual") errors.push("accepted decision form missing appliedBy=operator_manual");
  if (accepted?.appliedTo !== "disposable_copy") errors.push("accepted decision form missing appliedTo=disposable_copy");
  if (accepted?.originalRepoMutated !== false) errors.push("accepted decision form originalRepoMutated must be false");
  if (accepted?.afterValidation !== "passed") errors.push("accepted decision form missing afterValidation=passed");

  const rejected = await readOptionalJson<JsonObject>(join(root, "decision-form.rejected.json"));
  if (rejected?.decision !== "rejected") errors.push("rejected decision form missing decision=rejected");
  if (rejected?.reason !== "operator_declined") errors.push("rejected decision form missing reason=operator_declined");
  if (rejected?.originalRepoMutated !== false) errors.push("rejected decision form originalRepoMutated must be false");

  return { passed: errors.length === 0, errors };
}

function requiredFiles(): string[] {
  return [
    "README.md",
    "handoff.json",
    "proposal.patch",
    "apply-instructions.md",
    "validation.md",
    "rollback.md",
    "decision-form.accepted.json",
    "decision-form.rejected.json",
    "evidence-links.json"
  ];
}

async function readInstructionText(root: string): Promise<string> {
  const chunks = await Promise.all(["README.md", "apply-instructions.md", "validation.md", "rollback.md"].map(async (name) => {
    try {
      return await readFile(join(root, name), "utf8");
    } catch {
      return "";
    }
  }));
  return chunks.join("\n");
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
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
