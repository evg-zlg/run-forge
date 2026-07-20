export const checkpointLifecycleStatuses = [
  "created", "candidate_validation_required", "validated", "rejected", "accepted", "superseded",
] as const;

export type CheckpointLifecycleStatus = typeof checkpointLifecycleStatuses[number];
export type CheckpointKind = "implementation" | "repair";
export type CheckpointFile = { path: string; bytes: number; sha256: string };

export type CheckpointCompatibility = {
  reader: { minimumSchemaVersion: 1; maximumSchemaVersion: 2 };
  legacyV1VerifiedReadable: true;
  migration: { strategy: "read_only_no_rewrite"; migratedFrom: 1 | null };
  incompatibilities: string[];
};

export type DurableCheckpointInput = {
  checkpointId: string;
  taskId: string;
  projectId: string;
  executionAgreementId: string;
  sourceRunforgeSha: string;
  expectedBaseSha: string;
  iteration: number;
  attempt: number;
  generation: string;
  kind: CheckpointKind;
  createdAt?: string;
  lifecycleStatus?: CheckpointLifecycleStatus;
  workspace: {
    identity: string;
    workingDirectory: string;
    sha: string | null;
    state: "dirty" | "committed";
  };
  patch: string;
  changedFiles: string[];
  taskSpec: unknown;
  executionAgreement: unknown;
  authoritySnapshot: unknown;
  validationPlan: unknown;
  completedEvidence: unknown[];
  pendingPhases: string[];
  providerUsage: { implementation: unknown; repair: unknown; validation: unknown; review: unknown };
  executor: Record<string, unknown>;
  safetyAssertions: Record<string, boolean>;
  secretScanResult: unknown;
  unresolvedFindings: string[];
  incompatibilities?: string[];
};

export type LegacyDurableCheckpointManifest = {
  schemaVersion: 1;
  checkpointId: string;
  iteration: number;
  kind: CheckpointKind;
  createdAt: string;
  baseSha: string;
  workspaceSha: string | null;
  workspaceState: "dirty" | "committed";
  status: "available";
  files: CheckpointFile[];
};

export type DurableCheckpointManifest = {
  schemaVersion: 2;
  checkpointId: string;
  taskId: string;
  projectId: string;
  executionAgreementId: string;
  sourceRunforgeSha: string;
  expectedBaseSha: string;
  /** Compatibility alias for verified v1/v2 consumers. */
  baseSha: string;
  iteration: number;
  attempt: number;
  generation: string;
  kind: CheckpointKind;
  createdAt: string;
  status: CheckpointLifecycleStatus;
  sequence: number;
  previousDigest: string | null;
  transitionReason: string | null;
  workspace: DurableCheckpointInput["workspace"];
  patch: { path: "patch.diff"; sha256: string };
  changedFiles: string[];
  taskSpec: unknown;
  executionAgreement: unknown;
  authoritySnapshot: unknown;
  validationPlan: unknown;
  completedEvidence: unknown[];
  pendingPhases: string[];
  providerUsage: DurableCheckpointInput["providerUsage"];
  safetyAssertions: Record<string, boolean>;
  secretScanResult: unknown;
  files: CheckpointFile[];
  integrity: { algorithm: "sha256"; payloadSetSha256: string; contentAddressedBy: "manifest.json" };
  compatibility: CheckpointCompatibility;
};

export type DurableCheckpoint = {
  id: string;
  path: string;
  manifest: LegacyDurableCheckpointManifest | DurableCheckpointManifest;
  patchPath: string;
  digest: string;
};

export type CheckpointTransitionInput = {
  status: CheckpointLifecycleStatus;
  createdAt?: string;
  reason?: string;
  expectedPreviousDigest?: string;
};

export class CheckpointIntegrityError extends Error {
  readonly code = "checkpoint_integrity_error";
  constructor(
    readonly checkpointId: string,
    readonly artifact: string,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`checkpoint_integrity_error: ${checkpointId}/${artifact}`);
    this.name = "CheckpointIntegrityError";
  }
}

export class CheckpointCompatibilityError extends Error {
  readonly code = "checkpoint_incompatible";
  constructor(readonly checkpointId: string, readonly schemaVersion: unknown) {
    super(`checkpoint_incompatible: ${checkpointId} uses unsupported schema ${String(schemaVersion)}`);
    this.name = "CheckpointCompatibilityError";
  }
}
