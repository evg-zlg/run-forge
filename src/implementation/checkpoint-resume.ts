import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ControlPlaneError, type CheckpointResumeRequest, type ControlTaskRecord } from "../control-plane/contracts.js";
import { aggregateValidationOutcomes, validationSatisfiesImplementationCheckpoint, type ValidationPlanEntry, type ValidationPreflightPlan } from "../validation/capability-contract.js";
import { createGitEvidenceBinding, parseGitEvidenceCommand } from "../validation/git-evidence-lane.js";
import { CheckpointCompatibilityError, CheckpointIntegrityError, publishDurableCheckpointTransition, readDurableCheckpoint, type DurableCheckpointManifest } from "./durable-checkpoint.js";
import { runValidation, type CommandDiagnostic } from "./validation-command-runner.js";
import { detectPackageValidationCapabilities } from "./validation-runtime-capabilities.js";
import { prepareResumeWorkspace, prepareTaskOwnedDependencies } from "./workspace-continuity.js";

const execFileAsync = promisify(execFile);
type ResumeContext = { task: ControlTaskRecord; taskSpec: Record<string, any>; checkpointId: string; request: CheckpointResumeRequest };

export async function resumeDurableCheckpoint(input: ResumeContext): Promise<Record<string, unknown>> {
  const { task, request } = input, resumeRoot = join(task.artifactRoot, "checkpoint-resume", input.checkpointId);
  const requestDigest = sha(JSON.stringify(stable(request))), responsePath = join(resumeRoot, `${requestDigest}.response.json`);
  const replay = await readJson(responsePath); if (replay) return { idempotentReplay: true, ...replay };
  await mkdir(resumeRoot, { recursive: true }); const lock = join(resumeRoot, ".generation.lock");
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(task.id, input.checkpointId, "A checkpoint resume generation is already active."); throw error; }
  const generation = randomUUID(), leasePath = join(resumeRoot, "lease.json");
  try {
    const existingLease = await readJson(leasePath);
    if (existingLease && existingLease.requestDigest !== requestDigest) throw conflict(task.id, input.checkpointId, "Checkpoint resume is already bound to another request generation.");
    await atomicJson(leasePath, { schemaVersion: 1, checkpointId: input.checkpointId, taskId: task.id, generation, requestDigest, state: "active", startedAt: new Date().toISOString() });
    const response = await executeResume(input, generation, requestDigest);
    await atomicJson(responsePath, response); await atomicJson(leasePath, { schemaVersion: 1, checkpointId: input.checkpointId, taskId: task.id, generation, requestDigest, state: "finished", responsePath: relative(task.artifactRoot, responsePath), finishedAt: new Date().toISOString() });
    return response;
  } catch (error) { await rm(leasePath, { force: true }); throw error;
  } finally { await rmdir(lock).catch(() => undefined); }
}

async function executeResume(input: ResumeContext, generation: string, requestDigest: string): Promise<Record<string, unknown>> {
  const { task, request, checkpointId } = input; let checkpoint;
  try { checkpoint = await readDurableCheckpoint(request.artifactRoot, checkpointId); }
  catch (error) { throw checkpointError(error, task.id, checkpointId); }
  if (!checkpoint) throw new ControlPlaneError(404, "checkpoint_not_found", `Portable checkpoint not found: ${checkpointId}`, handoff(checkpointId, "Locate the immutable checkpoint artifact."), false, task.id);
  if (checkpoint.manifest.schemaVersion !== 2) throw incompatible(task.id, checkpointId, "Checkpoint resume requires schema v2; legacy v1 remains verified read-only.");
  const manifest = checkpoint.manifest;
  await verifyBindings(input, manifest);
  const candidateBinary = await readFile(request.candidateBinary.path).catch(() => null), actualBinarySha = candidateBinary ? sha(candidateBinary) : null;
  const actualSourceSha = await git(dirname(request.candidateBinary.path), ["rev-parse", "HEAD"]).then((value) => value.trim(), () => null);
  if (!candidateBinary || actualBinarySha !== request.candidateBinary.sha256 || actualSourceSha !== request.candidateBinary.sourceRunforgeSha) throw new ControlPlaneError(409, "checkpoint_integrity_error", "Candidate binary SHA-256 or source SHA could not be verified.", { expected: { binary: request.candidateBinary.sha256, source: request.candidateBinary.sourceRunforgeSha }, actual: { binary: actualBinarySha, source: actualSourceSha }, ...handoff(checkpointId, "Provide a candidate binary from the declared RunForge source SHA with its exact SHA-256.") }, false, task.id);
  if (request.candidateBinary.minimumCheckpointSchemaVersion > 2 || request.candidateBinary.maximumCheckpointSchemaVersion < 2 || manifest.compatibility.incompatibilities.some((item) => !request.candidateBinary.features.includes(item))) throw incompatible(task.id, checkpointId, "Candidate binary is not compatible with this checkpoint schema or feature set.");
  const workspaceId = `resume-${checkpointId}-${generation}`, workspace = join(request.artifactRoot, "checkpoint-resume", checkpointId, "workspaces", workspaceId);
  const workspacePreparation = await prepareResumeWorkspace({ taskId: task.id, repository: request.targetRepository, baseSha: manifest.expectedBaseSha, workspace, workspaceId }).catch((error) => { throw incompatible(task.id, checkpointId, `Expected base SHA cannot be reconstructed: ${message(error)}`); });
  if (["conflict_external", "unsafe", "cleanup_failed"].includes(workspacePreparation.classification)) throw conflict(task.id, checkpointId, workspacePreparation.detail);
  if (workspacePreparation.classification === "reused") { await git(workspace, ["reset", "--hard", manifest.expectedBaseSha]); await git(workspace, ["clean", "-fd"]); }
  try { await git(workspace, ["apply", "--index", "--binary", checkpoint.patchPath]); }
  catch (error) { throw new ControlPlaneError(409, "checkpoint_incompatible", "Checkpoint patch does not apply cleanly to the expected base SHA.", { reason: message(error), ...handoff(checkpointId, "Restart from the expected base SHA or migrate the checkpoint patch.") }, false, task.id); }
  const executionRoot = resolve(workspace, request.workingDirectory);
  if (!inside(workspace, executionRoot)) throw wrong(task.id, checkpointId, "workingDirectory escapes the reconstructed workspace");
  const dependencyPreparation = await prepareTaskOwnedDependencies({ taskId: task.id, workspaceId, workspaceRoot: workspace, executionRoot, ...request.dependency }).catch((error) => { throw conflict(task.id, checkpointId, `Dependency preparation failed: ${message(error)}`); });
  if (["conflict_external", "unsafe", "cleanup_failed"].includes(dependencyPreparation.classification)) throw conflict(task.id, checkpointId, dependencyPreparation.detail);
  const changedFiles = lines(await git(workspace, ["diff", "--name-only", manifest.expectedBaseSha]));
  const reconstructedPatchSha256 = sha(await git(workspace, ["diff", "--binary", "--no-ext-diff", manifest.expectedBaseSha]));
  const filesystemIntegrity = { changedFilesMatch: JSON.stringify(changedFiles.sort()) === JSON.stringify([...manifest.changedFiles].sort()), patchSha256: manifest.patch.sha256, appliedPatchSha256: sha(await readFile(checkpoint.patchPath)), reconstructedPatchSha256 };
  if (!filesystemIntegrity.changedFilesMatch || filesystemIntegrity.patchSha256 !== filesystemIntegrity.appliedPatchSha256 || filesystemIntegrity.appliedPatchSha256 !== reconstructedPatchSha256) throw new ControlPlaneError(409, "checkpoint_integrity_error", "Reconstructed filesystem does not match checkpoint metadata.", { filesystemIntegrity, ...handoff(checkpointId, "Use the immutable portable handoff or restart from the base SHA.") }, false, task.id);
  let candidate = checkpoint;
  if (manifest.status === "created") candidate = await publishDurableCheckpointTransition(request.artifactRoot, checkpointId, { status: "candidate_validation_required", expectedPreviousDigest: checkpoint.digest, reason: `candidate ${actualBinarySha}` });
  if (candidate.manifest.schemaVersion !== 2 || !["candidate_validation_required", "validated"].includes(candidate.manifest.status)) throw conflict(task.id, checkpointId, `Checkpoint lifecycle is ${candidate.manifest.status}.`);
  const pending = manifest.pendingPhases.filter((phase) => phase === "candidate_validation" || phase === "independent_review");
  const { plan, binding } = await reboundPlan(manifest.validationPlan, request.targetRepository, workspace, executionRoot, manifest.expectedBaseSha);
  const validations: CommandDiagnostic[] = pending.includes("candidate_validation") ? await runPlan(plan, request.artifactRoot, manifest.iteration, binding) : manifest.completedEvidence as CommandDiagnostic[];
  const aggregate = aggregateValidationOutcomes(validations.map((item) => ({ command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode, reason: item.failureReason, evidenceRole: item.evidenceRole })));
  const passed = validationSatisfiesImplementationCheckpoint(validations.map((item) => ({ command: item.command, acceptance: item.acceptance, outcome: item.outcome, exitCode: item.exitCode, reason: item.failureReason, evidenceRole: item.evidenceRole })));
  const evidence = { schemaVersion: 1, checkpointId, checkpointDigest: candidate.digest, sourceCheckpointDigest: checkpoint.digest, candidateAttemptId: generation, requestDigest, lineage: { checkpointGeneration: manifest.generation, candidateGeneration: generation }, candidateBinary: { path: request.candidateBinary.path, sha256: actualBinarySha, checkpointSchemaVersion: 2, compatible: true }, workspaces: { implementationWorkspaceId: manifest.workspace.identity, validationWorkspaceId: workspaceId, reconstructionMethod: "git_worktree_base_plus_binary_patch", baseSha: manifest.expectedBaseSha, appliedCheckpoint: checkpointId }, filesystemIntegrity, gitEvidenceLane: binding ? { repositoryIdentity: binding.repositoryIdentity, boundSha: binding.boundSha, safetyAssertions: binding.safetyAssertions } : { unavailable: true }, dependencyStrategy: dependencyPreparation, workspacePreparation, pendingPhasesExecuted: pending, review: pending.includes("independent_review") ? { status: "structural_only_no_provider", providerCalls: 0 } : { status: "not_pending", providerCalls: 0 }, validationAggregate: aggregate, validations, providerCalls: 0, lateOldGenerationResultsIgnored: true, createdAt: new Date().toISOString() };
  const evidenceText = JSON.stringify(evidence, null, 2) + "\n", evidenceDigest = sha(evidenceText), evidencePath = join(request.artifactRoot, "checkpoint-resume", checkpointId, `${evidenceDigest}.candidate-validation-evidence.json`); await atomicText(evidencePath, evidenceText); await chmod(evidencePath, 0o400);
  if (candidate.manifest.status !== "validated") await publishDurableCheckpointTransition(request.artifactRoot, checkpointId, { status: passed ? "validated" : "rejected", expectedPreviousDigest: candidate.digest, reason: relative(request.artifactRoot, evidencePath) });
  return { schemaVersion: 1, taskId: task.id, checkpointId, checkpointDigest: checkpoint.digest, generation, status: passed ? "validated" : "rejected", providerCalls: 0, providerRerun: false, candidateBinarySha256: actualBinarySha, evidence: relative(request.artifactRoot, evidencePath), portableHandoff: handoff(checkpointId, passed ? "Accept the validated checkpoint without a provider rerun." : "Inspect validation evidence or restart from the base SHA."), reconstruction: evidence.workspaces, dependencyPreparation, validationAggregate: aggregate };
}

async function verifyBindings(input: ResumeContext, manifest: DurableCheckpointManifest): Promise<void> {
  const { task, request, taskSpec, checkpointId } = input, target = object(taskSpec.target), manifestAgreement = object(manifest.executionAgreement), taskAgreement = object(task.executionAgreement);
  const executionAgreementMatch = manifest.executionAgreementId === request.executionAgreementId && String(manifestAgreement.id) === request.executionAgreementId && String(taskAgreement.agreementId) === request.executionAgreementId && ["schemaVersion", "profile"].every((key) => stable(manifestAgreement[key]) === stable(taskAgreement[key]));
  const [requestedArtifacts, taskArtifacts] = await Promise.all([realpath(request.artifactRoot).catch(() => ""), realpath(task.artifactRoot).catch(() => "invalid")]);
  const checks: Array<[boolean, string]> = [[manifest.taskId === task.id, "taskId"], [manifest.projectId === request.projectId, "projectId"], [requestedArtifacts === taskArtifacts, "artifactRoot"], [executionAgreementMatch, "executionAgreement"], [manifest.expectedBaseSha === request.expectedBaseSha && target.expectedSha === request.expectedBaseSha, "expectedBaseSha"], [manifest.workspace.workingDirectory === request.workingDirectory && target.workingDirectory === request.workingDirectory, "workingDirectory"], [stable(manifest.authoritySnapshot) === stable(request.authoritySnapshot), "authoritySnapshot"]];
  const requestedRepo = await import("node:fs/promises").then(({ realpath }) => realpath(request.targetRepository)).catch(() => ""), taskRepo = await import("node:fs/promises").then(({ realpath }) => realpath(String(target.repository))).catch(() => "invalid"); checks.push([requestedRepo === taskRepo && manifest.projectId === String(target.repository), "repositoryIdentity"]);
  const failed = checks.filter(([ok]) => !ok).map(([, name]) => name); if (failed.length) throw wrong(task.id, checkpointId, failed.join(", "));
}
async function reboundPlan(value: unknown, repository: string, workspace: string, executionRoot: string, baseSha: string): Promise<{ plan: ValidationPreflightPlan; binding: Awaited<ReturnType<typeof createGitEvidenceBinding>> | undefined }> {
  const source = object(value), commands = Array.isArray(source.commands) ? source.commands as ValidationPlanEntry[] : [], packageEvidence = await detectPackageValidationCapabilities({ commands: commands.map((item) => item.command), executionRoot, workspaceRoot: workspace }); let binding: Awaited<ReturnType<typeof createGitEvidenceBinding>> | undefined; try { binding = await createGitEvidenceBinding({ targetRepository: repository, evidenceWorkspace: workspace, expectedSha: baseSha }); } catch { binding = undefined; }
  const rebound = commands.map((entry) => { const gitEntry = /^git(?:\s|$)/.test(entry.command); if (gitEntry) { const parsed = parseGitEvidenceCommand(entry.command, baseSha), supported = Boolean(binding && parsed.supported); return { ...entry, cwd: workspace, repositoryIdentity: binding?.repositoryIdentity, boundSha: binding?.boundSha, supported, disposition: supported ? "execute" as const : "capability_unsupported" as const }; } const available = entry.availableCapabilities.filter((item) => !["package-manager", "dependencies"].includes(item)); if (packageEvidence.packageManager) available.push("package-manager"); if (packageEvidence.dependencies) available.push("dependencies"); const missing = entry.requiredCapabilities.filter((item) => !available.includes(item)), supported = entry.supported && missing.length === 0; return { ...entry, cwd: executionRoot, availableCapabilities: [...new Set(available)].sort(), missingCapabilities: missing, supported, disposition: supported ? entry.disposition : "capability_unsupported" as const, reason: supported ? entry.reason : `Missing candidate capabilities: ${missing.join(", ")}.` }; });
  return { plan: { ...(source as ValidationPreflightPlan), commands: rebound }, binding };
}
async function runPlan(plan: ValidationPreflightPlan, root: string, iteration: number, binding: Awaited<ReturnType<typeof createGitEvidenceBinding>> | undefined): Promise<CommandDiagnostic[]> { const results: CommandDiagnostic[] = []; for (let index = 0; index < plan.commands.length; index += 1) results.push(await runValidation(plan.commands[index]!, root, iteration, index, 120_000, undefined, binding)); return results; }
function checkpointError(error: unknown, taskId: string, checkpointId: string): ControlPlaneError { if (error instanceof CheckpointIntegrityError) return new ControlPlaneError(409, error.code, error.message, { artifact: error.artifact, expected: error.expected, actual: error.actual, ...handoff(checkpointId, "Use an untampered portable checkpoint.") }, false, taskId); if (error instanceof CheckpointCompatibilityError) return incompatible(taskId, checkpointId, error.message); return error as ControlPlaneError; }
function incompatible(taskId: string, checkpointId: string, reason: string): ControlPlaneError { return new ControlPlaneError(409, "checkpoint_incompatible", reason, handoff(checkpointId, "Migrate with a compatible reader or restart from the expected base SHA."), false, taskId); }
function wrong(taskId: string, checkpointId: string, field: string): ControlPlaneError { return new ControlPlaneError(409, "wrong_identity", `Checkpoint resume identity mismatch: ${field}.`, handoff(checkpointId, "Use the matching task/project/workspace/authority context."), false, taskId); }
function conflict(taskId: string, checkpointId: string, reason: string): ControlPlaneError { return new ControlPlaneError(409, "conflict", reason, handoff(checkpointId, "Retry the identical request after the active generation finishes, or restart as a new task."), true, taskId); }
function handoff(checkpointId: string, nextAction: string): Record<string, unknown> { return { portableHandoff: { checkpointId, patch: `checkpoints/${checkpointId}/patch.diff`, migrationOptions: ["compatible_v2_reader", "read_only_patch_handoff"], restartOptions: ["expected_base_sha", "new_task"], nextAction } }; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
async function atomicText(path: string, value: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, path); }
async function readJson(path: string): Promise<Record<string, any> | null> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd, maxBuffer: 10_000_000 })).stdout; }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function stable(value: unknown): string { return JSON.stringify(canonical(value)); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function lines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
