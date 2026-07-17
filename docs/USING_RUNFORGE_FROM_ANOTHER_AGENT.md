# Using RunForge from another agent session

RunForge exposes a persistent, localhost-only HTTP control plane. A product-project session can discover capabilities, register its checkout, submit TaskSpec v2, poll durable state, and record explicit decisions without entering the RunForge checkout or knowing its CLI layout.

## Start and stop

```bash
runforge control-plane start
runforge control-plane status
runforge control-plane stop
```

For foreground development use `corepack pnpm dev -- control-plane serve`. The default URL is `http://127.0.0.1:7373`; state and the versioned lifecycle journal are stored atomically under `~/.runforge/control-plane`. The service refuses non-loopback binds. On restart, in-flight tasks become `interrupted`; success is never inferred.

## Bootstrap prompt for a product session

```text
Use the RunForge control plane at http://127.0.0.1:7373.
Do not enter or inspect the RunForge repository and do not invoke its CLI.
First GET /.well-known/runforge and /v1/capabilities.

Before implementation, require a compatible `implementationExecutors` entry with `status: "ready"`. With no compatible backend, RunForge rejects the request with `executor_unavailable` before creating the task; it never silently performs inspection.
Then POST /v1/projects/inspect with this project's absolute checkout path and working directory.
Submit a TaskSpec v2 to POST /v1/tasks with an explicit authority object.
Poll GET /v1/tasks/{id}; read GET /v1/tasks/{id}/result when ready.
While status is running or continuing, inspect progress.phase, progress.operation, progress.lastHeartbeatAt, progress.workerStatus, progress.deadlineAt, progress.summary, and progress.diagnostic.
GET /healthz reports HTTP-service health; GET /readyz separately reports acceptance readiness and task aggregates. A degraded task does not disable read-only operations.
Treat implementation, local branch/commit, remote push, draft publication, merge, and deploy as separate authorities.
Never infer approval. Use owner-decisions and continue only after an explicit owner decision.
For interrupted tasks, first inspect `recovery.retryAvailable`. Execute only the exact `recovery.operation` advertised by the task. During bounded cleanup it is absent, `retryAvailable` is false, and `retryAfter` plus the task polling URL are authoritative. POST `/v1/tasks/{id}/retry` is idempotent while the replacement attempt is active; POST `/v1/tasks/{id}/cancel` is a distinct idempotent cancellation operation.
Use publication-decisions separately; merge and deploy are unavailable.
```

## Minimal API flow

```bash
BASE=http://127.0.0.1:7373
curl -fsS "$BASE/.well-known/runforge"
curl -fsS "$BASE/v1/capabilities"

The default backend is the locally available `codex` CLI. It can instead be set through an enabled `codex-cli` admin provider or `RUNFORGE_IMPLEMENTATION_EXECUTOR_COMMAND`. Credentials remain in the CLI credential store and are never copied into TaskSpec, logs, or results.

Implementation adds explicit mode and independent provider/network authority:

```json
{
  "taskSpec": {
    "execution": { "mode": "implementation", "maxRepairIterations": 2, "maxProviderTokens": 100000 },
    "runtime": { "preference": "local", "externalNetwork": "allowed" },
    "authority": {
      "profile": "bounded-implementation",
      "allowProviderCalls": true,
      "allowNetwork": true,
      "forbiddenAreas": [".github", "deploy", "migrations"]
    },
    "git": { "publication": "none" }
  },
  "authority": { "implementation": true, "providerCalls": true, "network": true }
}
```

Poll `selection` and `progress.phase`. The result reports `implementation.status`, changed files, validation stdout/stderr evidence, `localCommit`, `patchPackage`, provider-call audit, and `publication.status: "on_hold"`.
curl -fsS -H 'content-type: application/json' -d '{"path":"/absolute/project","workingDirectory":".","register":true}' "$BASE/v1/projects/inspect"
```

Submit TaskSpec v2 as `taskSpec` and keep authority explicit:

```json
{
  "projectId": "prj_...",
  "taskSpec": {
    "schemaVersion": 2, "taskId": "PROJECT-LOCAL-1",
    "task": { "text": "Validate locally", "goal": "Produce evidence", "acceptanceCriteria": ["Checks are recorded"] },
    "target": { "repository": "/absolute/project", "workingDirectory": "." },
    "authority": { "profile": "read-only", "allowProviderCalls": false },
    "git": { "publication": "none" }, "merge": { "policy": "never" }, "deploy": { "policy": "never" }
  },
  "authority": { "inspect": true, "implementation": false, "localBranch": false, "localCommit": false, "remotePush": false, "draftPublication": false, "merge": false, "deploy": false },
  "publication": "none"
}
```

JSON bodies are bounded to 1 MiB by default. Unknown fields, malformed JSON, non-local Host/Origin values, authority escalation, merge, and deploy are rejected. Responses are redacted and never cacheable. Publication approval is durable and idempotent, but never performs a provider call by itself.

## Polling and recovery

Poll every 1–2 seconds. A task is considered stalled when its durable execution lease has no matching in-memory worker, its deadline passes, or its heartbeat is older than 15 seconds. The lifecycle is `running|continuing → interrupted(cleanup pending) → interrupted(retry available) → retry_requested → running|continuing`. The watchdog revokes the old generation and waits a bounded cleanup window. It publishes `recovery.operation` only after the underlying worker Promise has settled. During cleanup, retry returns `recovery_pending` with an exact `retryAfter` and polling action; it never returns an unbounded `task_active` for a task that health reports inactive. If cleanup does not complete by the deadline, the task reports `cleanupStatus: detached`, keeps `retryAvailable: false`, and returns the formal non-retryable `worker_cleanup_failed` response with safe operator actions; RunForge does not overlap a replacement with a worker that could still mutate the target. Polling continues to reconcile a detached generation, so an eventually settled worker changes cleanup to `completed` and makes retry available without a service restart.

Health aggregates, retry guards, and watchdog checks all use the same live-lease predicate: a running/continuing durable status, an active durable lease, and a matching live worker generation. Poll-driven recovery reconciliation runs under the same per-task lock as retry, so an old interrupted snapshot cannot overwrite a new attempt. Every retry receives a new `progress.executionId`, increments `progress.attempt`, and uses an isolated attempt artifact root, including continuation retries. Two concurrent retry requests return the same active replacement attempt. A late result from a revoked generation is never accepted or published for the current generation.

`GET /result` is available for `interrupted` even before retry. Its normalized result records the last phase, interruption reason, original execution identity, heartbeat/deadline evidence, non-inferred mutation status, artifacts, incomplete validations, recovery availability, safety assertions, and next action. `result_not_ready` is reserved for an execution that is genuinely active and has not produced a generation-matched result. On service restart, active durable leases are revoked, journal evidence is reconciled with the snapshot, and interrupted recovery becomes immediately retryable because no process-local worker can survive the restart.

An approving owner decision is recorded once with a stable `decisionId`; replaying the identical request is safe, while a conflicting decision is HTTP 409. `continue` is also idempotent after completion. Missing or corrupt native continuation state is restored only from the control plane's versioned, authority-bound snapshot. Completed, failed, and owner-gated tasks are not retryable; operator-cancelled executions follow the same bounded cleanup and explicit retry policy as watchdog interruptions.

Contracts: [TaskSpec v2](../schemas/task-spec-v2.schema.json), [task result v1](../schemas/task-result-v1.schema.json), and [control plane v1](../schemas/control-plane-v1.schema.json).
