import type { TaskKind } from "./task-run-planner.js";

export function ownerConclusion(task: string, kind: TaskKind): string {
  const normalized = task.toLowerCase();
  if (kind === "docs-review") {
    return "The accepted docs task was answered from roadmap/current-state evidence: the owner decision is about documentation consistency, roadmap gaps, and the next docs-safe task-run milestone.";
  }
  if (kind === "code-inspection") {
    if (asksForNonProviderPlanning(normalized)) {
      return "The accepted non-provider code task was answered from harness evidence: the next gap is semantic task-specific planning / owner-decision binding, because planner lanes and owner conclusions must follow the accepted task instead of drifting toward provider work.";
    }
    return "The accepted code task was answered from harness evidence: the next smallest gap is delegated coding/review agents, because planning, local executor dispatch, and artifact rendering are now explicit but still single-host.";
  }
  return `The accepted task was routed through a generic repository review path; the result is useful but would benefit from a semantic planner for sharper decomposition. Task: ${task}`;
}

export function recommendedNextStep(milestone: string): string {
  return `Recommended next milestone: ${milestone}.`;
}

export function remainingGaps(kind: TaskKind, task = ""): string[] {
  const normalized = task.toLowerCase();
  const gaps = ["Docker/container isolation is still recorded as a gap; disposable tmp workspace snapshots are used now."];
  if (kind === "docs-review") gaps.push("Docs review is deterministic keyword evidence, not semantic contradiction reasoning.");
  if (kind === "code-inspection" && asksForNonProviderPlanning(normalized)) {
    gaps.push("Planner lanes, selected milestone, and owner conclusions still need stronger binding to the accepted task.");
  } else if (kind === "code-inspection") {
    gaps.push("Subtask execution uses the local shell executor, not delegated coding/review agents.");
  }
  return gaps;
}

function asksForNonProviderPlanning(normalizedTask: string): boolean {
  return (
    normalizedTask.includes("non-provider") ||
    normalizedTask.includes("semantic") ||
    normalizedTask.includes("owner-decision") ||
    normalizedTask.includes("owner decision") ||
    normalizedTask.includes("task-specific planning") ||
    normalizedTask.includes("task-specific planner")
  );
}
