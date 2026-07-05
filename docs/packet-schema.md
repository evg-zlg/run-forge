# RunForge Packet Schema Contract

RunForge packets are filesystem artifact directories produced by external workflows. They are intended to be stable enough for local inspectors, future UI surfaces, and API adapters. This document describes the Alpha-8 contract and its machine-checkable validation layer.

## Machine Validation

Alpha-6 adds JSON Schema reference files under `schemas/`:

- `schemas/check-packet.schema.json`
- `schemas/failure-triage-packet.schema.json`
- `schemas/proposal-readiness-packet.schema.json`
- `schemas/code-proposal-packet.schema.json`

The local packet inspector also supports runtime validation:

```bash
pnpm dev packet inspect --packet /path/to/packet --validate
pnpm dev packet inspect --packet /path/to/packet --validate --format json
```

The runtime validator checks required packet artifacts, required JSON fields, core field types, status/outcome enums, event structure, metrics and safety report identity fields, provider audit metadata, and manifest references to existing files. It is useful for local CI and future UI/API adapters while remaining small enough to run without a separate schema engine.

## Common Contract

Every packet directory MUST include:

- `run.json`: canonical run identity, packet type, status, timing, source paths, and `artifactDir`.
- `summary.md`: concise human-readable summary.
- `events.jsonl`: newline-delimited event records.
- `metrics.json`: machine-readable counters and outcome fields.
- `safety-report.json`: mutation, push, merge, deploy, and workspace safety evidence.
- `trajectory.json`: ordered coarse steps for graph/debug views.
- `packet-manifest.json`: inventory of packet artifacts with path, type, size, hash, and creation time.

Common JSON fields:

- `schemaVersion`: packet schema family. Current external packet versions are `alpha-3a`, `alpha-3b`, and `alpha-3c`.
- `runId`: stable identifier shared by all artifacts in the packet.
- `taskType`: one of `external_command_check`, `external_failure_triage`, `external_proposal_readiness`, `external_code_proposal`.
- `status`: packet-specific outcome.
- `startedAt`, `finishedAt`, `durationMs`: timing fields when a workflow owns execution.
- `artifactDir`: absolute packet directory path.

Event model:

- `events.jsonl` records JSON objects with `schemaVersion`, `eventId`, `runId`, `type`, and `time`.
- Packet producers SHOULD emit `task_received`, `route_selected`, source packet events when applicable, artifact write events, and `run_finished`.
- Code proposal packets also emit `worker_started` and `worker_finished` events with `workerId`, `workerRole`, status, and output artifact paths.
- Consumers SHOULD treat unknown event types as compatible additions.

Safety model:

- External packets MUST preserve `originalRepoMutationAllowed: false` unless a future schema explicitly changes the contract.
- Safety reports SHOULD include `noPushAttempted`, `noMergeAttempted`, `noDeployAttempted`, and `noApplyToOriginalRepoAttempted`.
- Code proposal packets MUST state that patches were applied only in a disposable workspace when verification ran.
- Human review remains required for proposal packets.

Manifest expectations:

- `packet-manifest.json` lists artifacts relative to the packet root.
- Manifest entries include `path`, `type`, `sizeBytes`, `hash`, and `createdAt`.
- Viewers SHOULD prefer manifest order sorted by path but tolerate missing optional artifacts.

Compatibility expectations:

- Consumers MUST ignore unknown fields.
- Producers SHOULD add new fields without changing existing field meaning.
- Removing required artifacts or changing status strings requires a new schemaVersion and migration note.
- File paths in packet JSON may be absolute for local traceability; UI/API layers should avoid assuming portability across machines.

## External Check Packet

Purpose: run explicit user-provided commands in a disposable workspace and capture command, log, safety, and mutation evidence.

Required artifacts:

- `run.json`
- `command-results.json`
- `summary.md`
- `events.jsonl`
- `metrics.json`
- `safety-report.json`
- `trajectory.json`
- `packet-manifest.json`
- command logs under `logs/` when commands produce captured stdout/stderr

Important fields:

- `run.json.taskType`: `external_command_check`
- `run.json.status`: `passed`, `failed`, `blocked`, `timed_out`, or `error`
- `run.json.repo`: original repo path, before/after head, status, dirty baseline, and mutation verdict
- `run.json.workspace`: disposable workspace path and change summary
- `command-results.json.commands[]`: command id, index, command text, status, exit code, duration, log paths, byte counts, and truncation booleans
- `metrics.json`: duration, command counts, pass/fail/block/timeout/error counts, total log bytes, and mutation verdict

## Failure Triage Packet

Purpose: classify a check packet or command failure into a conservative root-cause category and next action.

Required artifacts:

- `run.json`
- `root-cause.json`
- `summary.md`
- `human-review.md`
- `failure-triage.md`
- `evidence-excerpts.md`
- `safe-next-action.md`
- `events.jsonl`
- `metrics.json`
- `safety-report.json`
- `trajectory.json`
- `packet-manifest.json`

Important fields:

- `run.json.taskType`: `external_failure_triage`
- `run.json.status`: `triaged`, `no_failure_observed`, or safety/error status
- `root-cause.json.category`: examples include `test_assertion_failure`, `typecheck_error`, `build_error`, `dependency_missing`, `timeout`, `configuration_error`, and `unknown_failure`
- `root-cause.json.confidence`: `high`, `medium`, or `low`
- `root-cause.json.readyForCodeProposal`: boolean gate used by readiness
- `root-cause.json.requiresMoreContext`: boolean conservative fallback signal
- `root-cause.json.evidenceBasis`: short evidence bullets

## Proposal Readiness Packet

Purpose: convert triage output into a contract that says whether a proposal-only code patch may be attempted.

Required artifacts:

- `run.json`
- `proposal-contract.json`
- `summary.md`
- `human-review.md`
- `proposal-readiness.md`
- `missing-context.md`
- `recommended-next-action.md`
- `events.jsonl`
- `metrics.json`
- `safety-report.json`
- `trajectory.json`
- `packet-manifest.json`

Important fields:

- `run.json.taskType`: `external_proposal_readiness`
- `run.json.status`: readiness outcome
- `proposal-contract.json.readinessOutcome`: `ready_for_code_proposal`, `needs_more_context`, `research_only`, `blocked_by_safety`, or `no_failure_observed`
- `proposal-contract.json.canAttemptCodeProposal`: boolean consumed by code proposal
- `proposal-contract.json.failureCategory`: triage category carried forward
- `proposal-contract.json.humanGate`: currently `required`
- `proposal-contract.json.forbiddenActions`: includes original repo mutation, push, merge, deploy, and direct patch application
- `metrics.json`: readiness outcome, failure category, confidence, missing context count, and human gate flag

## Code Proposal Packet

Purpose: generate a deterministic or explicitly gated provider-backed proposal patch, apply it only in a disposable workspace, verify when commands are available, and package it for human review.

Required artifacts:

- `run.json`
- `proposal-status.json`
- `proposal.patch`
- `patch-summary.md`
- `summary.md`
- `human-review.md`
- `verification-results.json`
- `before-command-results.json`
- `after-command-results.json`
- `worker-notes/*.md`
- `events.jsonl`
- `metrics.json`
- `safety-report.json`
- `trajectory.json`
- `packet-manifest.json`

Important fields:

- `run.json.taskType`: `external_code_proposal`
- `run.json.status`: code proposal outcome
- `proposal-status.json.outcome`: `proposal_ready_verified`, `proposal_ready_unverified`, `no_safe_proposal`, `not_ready`, `verification_failed`, or `blocked_by_safety`
- `proposal-status.json.outcome`: provider mode can also report `provider_rejected` or `provider_failed`
- `proposal-status.json.strategy`: deterministic strategy name, `provider_cli`, or `null`
- `proposal-status.json.strategySource`: `deterministic`, `provider`, or `none`
- `proposal-status.json.providerEnabled`: true only when `--enable-provider-proposal` was used
- `proposal-status.json.providerStatus`: `disabled`, `not_run`, `accepted`, `rejected`, or `failed`
- `proposal-status.json.filesChanged`: proposed file paths
- `proposal-status.json.applyStatus`: disposable workspace patch apply status
- `proposal-status.json.reviewerDecision`: deterministic reviewer decision
- `proposal-status.json.verificationPassed`: true only when after-command verification ran and passed
- `metrics.json.strategy`: mirrors the selected strategy for dashboards
- `metrics.json.providerEnabled`, `providerBackend`, `providerDurationMs`, `providerInputBytes`, `providerOutputBytes`, `providerAccepted`, and `verificationStatus`: provider and verification telemetry
- `safety-report.json.patchAppliedOnlyInDisposableWorkspace`: true only when workspace application succeeded
- Provider-backed packets include `provider-input-summary.md`, `provider-output-summary.md`, and `provider-safety-report.json` when provider mode runs.

Provider audit fields:

- `providerAudit.enabled`: true for provider-backed runs.
- `providerAudit.backend`: currently `cli`.
- `providerAudit.commandHash`: SHA-256 hash of the provider command; raw provider commands should not be used as the audit key.
- `providerAudit.startedAt`, `finishedAt`, and `durationMs`: provider execution timing.
- `providerAudit.inputBytes`, `outputBytes`, and `patchBytes`: bounded accounting counters for comparing provider runs.
- `providerAudit.accepted` and `providerAudit.rejected`: safety gate outcome flags.
- `providerAudit.rejectionReason`: string reason for rejected/failed runs, otherwise `null`.
- `providerAudit.tokenUsage`: currently `null` until real token accounting exists.
- `providerAudit.estimatedCost`: currently `null` until real cost accounting exists.

Provider-backed packets must include `providerAudit` in `proposal-status.json`, `metrics.json`, and `provider-safety-report.json`.

Worker trace fields:

- `worker-notes/` contains one note per worker role.
- Expected deterministic code proposal worker roles are `readiness_loader`, `context_scout`, `failure_analyst`, `proposal_planner`, `patch_writer`, `verifier`, `proposal_reviewer`, and `packet_writer`.
- Provider-backed packets also emit `provider_input_builder`, `provider_runner`, `provider_patch_validator`, and `provider_safety_reviewer`.
- `events.jsonl` emits `worker_started` and `worker_finished` for worker graph reconstruction.
- `trajectory.json.steps[]` includes worker steps and proposal/review/verification milestones.

Deterministic strategy names currently include:

- `alpha3_calculator_assertion_fixture`
- `test_assertion_literal_mismatch`
- `typescript_missing_export_alias`
- `typescript_import_path_rewrite`
- `config_literal_mismatch`
- `package_script_alias`
- `docs_anchor_insert`
- `provider_cli` is reserved for explicitly enabled generic CLI provider proposals after deterministic strategies do not match.
