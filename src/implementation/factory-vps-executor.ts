import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ImplementationExecutorRequest,
  ImplementationExecutorResult,
} from "./executor.js";
import {
  factoryVpsProtocolVersion,
  requestFactoryVpsBridge,
} from "./factory-vps-contract.js";
import { buildFactoryVpsSourceBundle } from "./factory-vps-source-bundle.js";

type RemoteTask = {
  status?: string;
  baseSha?: string;
  changedFiles?: string[];
  validation?: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  semanticReview?: { status?: string; findings?: unknown[] };
  receipt?: {
    provider?: string;
    model?: string;
    tokens?: number;
    costUsd?: number;
    calls?: number;
  };
};

/** Production RunForge adapter for the private Factory VPS lane. It sends no
 * provider credentials and never mutates the local target checkout. */
export async function runFactoryVpsImplementationExecutor(
  request: ImplementationExecutorRequest,
): Promise<ImplementationExecutorResult> {
  const repository = process.env.RUNFORGE_FACTORY_VPS_REPOSITORY;
  const provider = process.env.RUNFORGE_FACTORY_VPS_PROVIDER;
  const model = process.env.RUNFORGE_FACTORY_VPS_MODEL;
  if (
    !repository ||
    !/^[A-Za-z0-9._/-]{1,512}$/.test(repository) ||
    !provider ||
    !model
  )
    throw new Error("factory_vps_remote_policy_not_configured");
  const validationTaskNames = (
    process.env.RUNFORGE_FACTORY_VPS_VALIDATION_TASKS ?? ""
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !validationTaskNames.every((name) => /^[A-Za-z0-9._:-]{1,80}$/.test(name))
  )
    throw new Error("factory_vps_validation_policy_invalid");
  const sourceMode = process.env.RUNFORGE_FACTORY_VPS_SOURCE_MODE ?? "git";
  if (sourceMode !== "git" && sourceMode !== "bundle") {
    throw new Error("factory_vps_source_mode_invalid");
  }
  const deadlineAt = new Date(
    Date.now() + request.spec.execution.timeoutMs,
  ).toISOString();
  const dispatch: Record<string, unknown> = {
    protocol: factoryVpsProtocolVersion,
    operation: "dispatch",
    requestId: randomUUID(),
    taskId: request.spec.taskId,
    attempt: Math.max(0, request.attempt - 1),
    generation: 0,
    nonce: randomUUID().replaceAll("-", ""),
    source:
      sourceMode === "bundle"
        ? await buildFactoryVpsSourceBundle(request.targetRepository, repository, request.spec.target.expectedSha)
        : {
            mode: "git",
            repository,
            ref: request.spec.target.expectedSha,
            baseSha: request.spec.target.expectedSha,
            allowlisted: true,
          },
    taskSpec: {
      mode: "implementation",
      instruction: `${request.spec.task.text}\nGoal: ${request.spec.task.goal}\nAcceptance: ${request.acceptanceCriteria.join("; ")}`,
    },
    executionAgreement: {
      semanticReview: request.spec.executionAgreement.profile !== "assist-only",
    },
    authority: {
      issuer: "runforge",
      implementation: true,
      providerCalls: true,
      network: true,
      publication: "none",
      deploy: "never",
      database: "none",
      production: "none",
      secretAccess: "none",
    },
    validationContract: { taskNames: validationTaskNames },
    providerPolicy: { provider, model },
    budgets: {
      deadlineAt,
      maxTokens: request.spec.execution.maxProviderTokens,
      maxCostUsd: request.spec.execution.maxCostUsd ?? 100,
    },
    integrity: { envelopeSha256: "" },
  };
  (dispatch.integrity as Record<string, string>).envelopeSha256 = createHash(
    "sha256",
  )
    .update(JSON.stringify({ ...dispatch, integrity: undefined }))
    .digest("hex");
  const accepted = await requestFactoryVpsBridge(
    dispatch,
    process.env,
    Math.min(request.spec.execution.timeoutMs, 30_000),
  );
  if (!accepted.ok)
    throw new Error(
      `factory_vps_dispatch_rejected:${accepted.error ?? "unknown"}`,
    );
  const key = {
    taskId: request.spec.taskId,
    attempt: Math.max(0, request.attempt - 1),
    generation: 0,
  };
  let remote: RemoteTask | undefined;
  while (Date.now() < Date.parse(deadlineAt)) {
    if (request.signal?.aborted) {
      await requestFactoryVpsBridge(
        {
          protocol: factoryVpsProtocolVersion,
          operation: "cancel",
          requestId: randomUUID(),
          ...key,
        },
        process.env,
        10_000,
      );
      throw new Error("factory_vps_cancelled");
    }
    const response = await requestFactoryVpsBridge(
      {
        protocol: factoryVpsProtocolVersion,
        operation: "result",
        requestId: randomUUID(),
        ...key,
      },
      process.env,
      15_000,
    );
    if (!response.ok)
      throw new Error(
        `factory_vps_result_rejected:${response.error ?? "unknown"}`,
      );
    remote = response.task as RemoteTask;
    if (
      ["completed", "failed", "cancelled", "interrupted"].includes(
        remote?.status ?? "",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!remote || !["completed", "failed"].includes(remote.status ?? ""))
    throw new Error(
      `factory_vps_terminal_status:${remote?.status ?? "deadline"}`,
    );
  let patch = "",
    patchPackage: string | null = null;
  if (remote.status === "completed" && remote.changedFiles?.length) {
    const artifact = await requestFactoryVpsBridge(
      {
        protocol: factoryVpsProtocolVersion,
        operation: "artifact-read",
        requestId: randomUUID(),
        ...key,
        artifact: "patch.diff",
      },
      process.env,
      15_000,
    );
    const content = (artifact.artifact as { content?: unknown } | undefined)
      ?.content;
    if (!artifact.ok || typeof content !== "string")
      throw new Error("factory_vps_patch_missing");
    patch = content;
    await mkdir(request.artifactRoot, { recursive: true });
    patchPackage = join(request.artifactRoot, "implementation.patch");
    await writeFile(patchPackage, patch, "utf8");
  }
  const receipt = remote.receipt ?? {},
    validation = remote.validation ?? [];
  return {
    plan: [
      "Dispatched to runforge-factory-vps over SSH stdio",
      "Collected immutable remote result artifacts",
    ],
    changedFiles: remote.changedFiles ?? [],
    patch,
    validationResults: validation.map((item) => ({
      command: item.command,
      cwd: "remote-disposable",
      startedAt: "",
      finishedAt: "",
      durationMs: item.durationMs,
      executor: "runforge-factory-vps",
      runtime: "remote-ephemeral",
      lane: "factory-vps",
      argv: null,
      exitCode: item.exitCode,
      signal: null,
      stdout: item.stdout,
      stderr: item.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      setupFailure: false,
      truncation: { stdout: false, stderr: false, limitBytes: 65536 },
      artifactPaths: ["validation.json"],
      failureReason: item.exitCode === 0 ? null : "remote_product_failure",
      classification: item.exitCode === 0 ? null : "product",
      diagnosticGap: false,
      infrastructureDefect: null,
      artifactPath: "validation.json",
      outcome: item.exitCode === 0 ? "passed" : "product_failed",
      acceptance: "required",
      evidenceRole: "product-validation",
      requiredCapabilities: [],
      availableCapabilities: [],
      missingCapabilities: [],
      repositoryIdentity: request.spec.target.expectedSha,
      boundSha: request.spec.target.expectedSha,
      safetyAssertions: ["remote disposable workspace"],
    })),
    validationPlan: {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      profile: request.spec.validation.profile,
      runtime: {} as never,
      commands: [],
    },
    validationAggregate: remote.status === "completed" ? "passed" : "product_failed",
    unresolvedFindings:
      remote.status === "completed" ? [] : ["remote_execution_failed"],
    status:
      remote.status === "completed"
        ? remote.changedFiles?.length
          ? "implemented_and_validated"
          : "no_change_required"
        : "failed_with_diagnostics",
    ownerGate: { required: false, reason: null },
    safetyAssertions: {
      targetUnchanged: true,
      noBranchCommitPush: true,
      remoteCredentialsOnly: true,
    },
    diagnostics: { remoteStatus: remote.status },
    localBranch: null,
    localCommit: null,
    patchPackage,
    providerCalls: [
      {
        provider: receipt.provider ?? provider,
        model: receipt.model ?? model,
        tokenUsage: receipt.tokens ?? null,
        costUsd: receipt.costUsd ?? null,
        phase: "implementer",
        remote: true,
      },
    ],
    selectedExecutor: {
      id: "runforge-factory-vps",
      model: receipt.model ?? model,
    },
    review: {
      structural: {
        kind: "structural",
        status: remote.status === "completed" ? "passed" : "product_failed",
        evidence: ["validation.json"],
      },
      semantic: {
        kind: "semantic",
        status:
          remote.semanticReview?.status === "completed"
            ? "completed"
            : "unavailable",
        performed: remote.semanticReview?.status === "completed",
        selectedReviewer: { provider, model },
        reviewer: { provider, model, invocationId: null },
        confidence: "unknown",
        limitations: [],
        findings: [],
        evidence: ["semantic-review.json"],
        delegation: null,
      },
    },
    checkpoints: [
      {
        id: "factory-vps-final",
        path: "checkpoint.json",
        patchPath: patchPackage ?? "",
        digest: createHash("sha256").update(patch).digest("hex"),
        iteration: 0,
        validationPassed: remote.status === "completed",
      },
    ],
    budget: {
      exceeded: false,
      overrunPhase: null,
      requestedTokens: request.spec.execution.maxProviderTokens,
      actualTokens: Number(receipt.tokens ?? 0),
      accounting: "provider",
      costUsd: typeof receipt.costUsd === "number" ? receipt.costUsd : null,
    },
  };
}
