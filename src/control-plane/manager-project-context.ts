import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExecutionAgreement, ExecutionAgreementContext } from "../product/execution-agreement.js";
import { inspectProject } from "../product/project-inspection.js";
import { ControlPlaneError, type ProjectRecord } from "./contracts.js";

export async function assertAgreementProjectBinding(input: {
  agreement: ExecutionAgreement;
  project: ProjectRecord | null;
  taskId: string;
}): Promise<void> {
  const { agreement, project, taskId } = input;
  const bound = agreement.context?.project;
  if (!bound) {
    if (!project) return;
    throw new ControlPlaneError(409, "execution_agreement_project_context_required", "A context-free Execution Agreement cannot authorize a registered-project task.", { agreementId: agreement.agreementId, projectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
  }
  if (!project) {
    throw new ControlPlaneError(409, "execution_agreement_project_mismatch", "The referenced Execution Agreement is bound to a different registered project.", { agreementId: agreement.agreementId, agreementProjectId: bound.projectId, taskProjectId: null, operation: "start_new_task", newTaskRequired: true }, false, taskId);
  }
  const current = await inspectProject(project.repository, project.workingDirectory).catch(() => null);
  const canonicalProjectMatches = current !== null && current.repositoryRoot !== null && current.workingDirectory !== null
    && project.id === bound.projectId
    && project.repository === current.repositoryRoot && project.workingDirectory === current.workingDirectory
    && bound.repository === current.repositoryRoot && bound.workingDirectory === current.workingDirectory;
  if (!canonicalProjectMatches) {
    throw new ControlPlaneError(409, "execution_agreement_project_mismatch", "The referenced Execution Agreement is not bound to the canonical registered project identity.", { agreementId: agreement.agreementId, agreementProjectId: bound.projectId, taskProjectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
  }
  if (!bound.source || current!.head !== bound.source.head || current!.branch !== bound.source.branch || current!.detachedHead !== bound.source.detachedHead) {
    throw new ControlPlaneError(409, "execution_agreement_source_stale", "The referenced Execution Agreement was negotiated for a different project source identity.", { agreementId: agreement.agreementId, projectId: project.id, operation: "renegotiate_execution_agreement", newTaskRequired: true }, false, taskId);
  }
}

export async function buildExecutionAgreementContext(input: {
  project: ProjectRecord | null;
  publicationTarget: ExecutionAgreementContext["publicationTarget"];
}): Promise<ExecutionAgreementContext> {
  const { project, publicationTarget } = input;
  if (!project) return {
    project: null,
    policy: { sources: ["runforge-installation-policy"], hardBoundaries: agreementHardBoundaries(), runforgeMd: { present: false, path: null, authorityEscalationTrusted: false } },
    publicationTarget,
  };
  const inspection = await inspectProject(project.repository, project.workingDirectory);
  if (!inspection.repositoryRoot || !inspection.workingDirectory) throw new ControlPlaneError(409, "registered_project_unavailable", "The registered project no longer resolves to a canonical repository and working directory.");
  const runforgeCandidates = [...new Set([join(project.repository, project.workingDirectory === "." ? "" : project.workingDirectory, "RUNFORGE.md"), join(project.repository, "RUNFORGE.md")])];
  const runforgePath = (await Promise.all(runforgeCandidates.map(async (candidate) => await access(candidate).then(() => candidate, () => null)))).find((candidate): candidate is string => candidate !== null) ?? null;
  const present = runforgePath !== null;
  const protectedBranches = [...new Set([inspection.defaultBranch, "main", "master", "develop", "source"].filter((item): item is string => Boolean(item)))].sort();
  return {
    project: {
      projectId: project.id, repository: inspection.repositoryRoot, workingDirectory: inspection.workingDirectory,
      source: { head: inspection.head, branch: inspection.branch, detachedHead: inspection.detachedHead },
      defaultBranch: inspection.defaultBranch, protectedBranches,
    },
    policy: {
      sources: ["runforge-installation-policy", ...(present ? ["project/RUNFORGE.md (defaults only; no authority escalation)"] : [])],
      hardBoundaries: agreementHardBoundaries(),
      runforgeMd: { present, path: runforgePath ? relative(project.repository, runforgePath) || "RUNFORGE.md" : null, authorityEscalationTrusted: false },
    },
    publicationTarget,
  };
}

function agreementHardBoundaries(): string[] {
  return [
    "No GitHub or GitLab push, PR/MR creation, or existing-change update adapter is available.",
    "No CI, merge, deploy, database, production, or secret adapter is available.",
    "Request maps may only narrow installation capability, authority, and policy.",
    "RUNFORGE.md supplies project defaults only and cannot grant authority or relax hard boundaries.",
  ];
}
