# Durable implementation results

RunForge persists every implementation and repair iteration as an immutable checkpoint before evaluating post-execution budget, owner, review, or publication gates. A gate may stop future work, but it cannot make an existing patch unavailable.

Each `checkpoints/{checkpointId}` directory contains `patch.diff`, changed files, validation, provider usage, executor metadata, safety assertions, unresolved findings, and a digest-bearing `manifest.json`. Publication uses atomic directory rename and refuses checkpoint replacement.

Normalized semantics keep independent status axes:

- `implementation.status`: whether code was implemented and validated.
- `artifact.status`: whether a portable checkpoint is available.
- `workflow.status`: whether workflow can continue or awaits an owner decision.

Provider usage is reported separately from synthetic accounting. Unknown cost is `null`, never inferred.

## Owner acceptance

`POST /v1/tasks/{id}/accept-completed-result` accepts `{ decisionId, checkpointId, delivery }`, where delivery is `patch` or `local_commit`. It is serialized and idempotent, returns the portable patch when requested, records the original budget overrun, and always reports `providerRerun: false`, `targetMainMutation: false`, and `authorityGranted: false`.

Owner gates name the completed work, available checkpoint IDs, blocked operations, and these choices: `accept_completed_patch`, `grant_additional_budget`, `stop_with_handoff`, `discard_result`, and `retry_from_checkpoint`. Discard requires explicit confirmation in a separate decision workflow; accepting never implies publication.

`POST /v1/tasks/{id}/checkpoint-repairs` makes the two provider-backed choices executable. The request is explicit and idempotent:

```json
{
  "taskId": "TASK-1",
  "decisionId": "owner-repair-1",
  "checkpointId": "implementation-0",
  "checkpointDigest": "<published sha256>",
  "choice": "retry_from_checkpoint",
  "repairIntent": "Repair only the recorded validation failure."
}
```

For `grant_additional_budget`, replace `repairIntent` with `additionalProviderTokens` (1–200000). The effective total and repair-phase budgets remain capped by the implementation executor contract. RunForge verifies the current normalized-result membership, manifest and payload digests, task ID, Execution Agreement ID, original base SHA, source freshness, and safety assertions before starting a new execution generation. The checkpoint patch is applied only in a new disposable worktree created from the original base SHA; the accepted authority envelope is reused without escalation. The new generation reruns validation and publishes a new immutable `repair-*` checkpoint plus normalized progress/result evidence. Reusing the same decision ID returns the same generation; changing its binding is rejected. Restart recovery uses the ordinary persisted execution lease and retry mechanism.

Unknown, cross-task, stale, unsafe, corrupt, or digest-mismatched checkpoints are rejected. A failed/unvalidated checkpoint still cannot be accepted through `accept-completed-result`; its immutable patch remains available as the patch-only fallback.

## Budgets, context, and timeouts

TaskSpec v2 supports `execution.phaseBudgets` for startup, analysis, implementation, validation, repair, review, and publication plus a soft/hard budget kind. Result usage contains actual provider tokens per phase, requested/effective limits, the overrun phase, and a separate empty `syntheticAccounting` namespace. Cost remains `null` when the provider does not report it.

The `small-scope` discovery profile starts from `discovery.explicitFiles`, task-named files, directly related validation/config, and minimum project policy. `context-plan.json` records deduplicated reads, reasons, file/byte/token bounds, expansion policy, and stop condition. The executor prompt forbids repository-wide or governance-corpus enumeration without a recorded expansion reason.

Task acceptance publishes requested/effective timeout, the limiting source, phase allocations, and watchdog policy. Capabilities publish the global executor cap before submission.

## Source state

Implementation supports `require_clean`, `allow_known_generated`, `snapshot_from_sha`, and `use_disposable_from_base_sha`. The default implementation mode creates a disposable worktree from the accepted base SHA, so unrelated shared-checkout dirt is preserved and ignored. `allow_known_generated` permits `.runforge/`, `.runforge-*`, and `artifacts/` telemetry while still rejecting unknown user dirt.

Cancellation, restart, failed later repair, owner gating, and publication failure do not remove previously renamed checkpoint directories. Terminal results project the latest safe patch and best available checkpoint into `handoffPackage`.
