import type { TaskKind } from "./task-run-planner.js";

export function ownerConclusion(task: string, kind: TaskKind): string {
  const normalized = task.toLowerCase();
  if (kind === "external-validation") {
    return "The external target was validated through the first-class task-run planner, Docker executor, providerless review, and artifact aggregation path. The original repository is a read-only source; commands run only in disposable writable workspaces.";
  }
  if (kind === "docs-review") {
    return "The accepted docs task was answered from roadmap/current-state evidence: the owner decision is about documentation consistency, roadmap gaps, and the next docs-safe task-run milestone.";
  }
  if (kind === "code-inspection") {
    if (asksForDockerRuntime(normalized)) {
      return "The accepted runtime task was answered from implementation evidence: Docker execution is now an explicit opt-in lane with a read-only workspace mount, disabled network, dropped capabilities, bounded resources, and owner-visible runtime metadata.";
    }
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

export function remainingGaps(kind: TaskKind, task = "", containerUsed = false): string[] {
  const normalized = task.toLowerCase();
  const gaps = containerUsed
    ? ["Docker isolation is available for evidence commands; runtime selection is not yet available for full coding-agent execution."]
    : ["Docker/container isolation is available as an opt-in lane; this run used disposable tmp workspace snapshots on the host."];
  if (kind === "external-validation") {
    return ["Offline validation reuses an existing target node_modules snapshot when present; platform-specific optional packages may require a separately prepared Linux dependency cache."];
  }
  if (kind === "docs-review") gaps.push("Docs review is deterministic keyword evidence, not semantic contradiction reasoning.");
  if (kind === "code-inspection" && asksForDockerRuntime(normalized)) {
    gaps.push("The Docker lane executes deterministic evidence commands; full coding-agent execution remains a separate owner-gated milestone.");
  } else if (kind === "code-inspection" && asksForNonProviderPlanning(normalized)) {
    gaps.push("Planner lanes, selected milestone, and owner conclusions still need stronger binding to the accepted task.");
  } else if (kind === "code-inspection") {
    gaps.push("Subtask execution uses the local shell executor, not delegated coding/review agents.");
  }
  return gaps;
}

function asksForDockerRuntime(normalizedTask: string): boolean {
  return normalizedTask.includes("docker") || normalizedTask.includes("container runtime") || normalizedTask.includes("container isolation");
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
