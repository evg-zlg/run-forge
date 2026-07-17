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
Then POST /v1/projects/inspect with this project's absolute checkout path and working directory.
Submit a TaskSpec v2 to POST /v1/tasks with an explicit authority object.
Poll GET /v1/tasks/{id}; read GET /v1/tasks/{id}/result when ready.
While status is running or continuing, inspect progress.phase, progress.operation, progress.lastHeartbeatAt, progress.workerStatus, progress.deadlineAt, progress.summary, and progress.diagnostic.
GET /healthz reports HTTP-service health; GET /readyz separately reports acceptance readiness and task aggregates. A degraded task does not disable read-only operations.
Treat implementation, local branch/commit, remote push, draft publication, merge, and deploy as separate authorities.
Never infer approval. Use owner-decisions and continue only after an explicit owner decision.
For interrupted tasks execute only the exact recovery.operation advertised by the task. POST /v1/tasks/{id}/retry is idempotent for a safe retry; POST /v1/tasks/{id}/cancel is a distinct idempotent cancellation operation.
Use publication-decisions separately; merge and deploy are unavailable.
```

## Minimal API flow

```bash
BASE=http://127.0.0.1:7373
curl -fsS "$BASE/.well-known/runforge"
curl -fsS "$BASE/v1/capabilities"
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

Poll every 1–2 seconds. A task is considered stalled by the service when its worker identity is lost, its execution deadline passes, or its heartbeat is older than 15 seconds. The watchdog then changes it to `interrupted`; clients must never leave a stale `running` task in their own UI. `recovery.reason`, `recovery.actions`, and `recovery.operation` are authoritative. An approving owner decision is recorded once with a stable `decisionId`; replaying the identical request is safe, while a conflicting decision is HTTP 409. `continue` is also idempotent after completion. Missing or corrupt native continuation state is restored only from the control plane's versioned, authority-bound snapshot. If validation fails, the task becomes formally interrupted and the API returns a versioned 409 error instead of guessing success.

Contracts: [TaskSpec v2](../schemas/task-spec-v2.schema.json), [task result v1](../schemas/task-result-v1.schema.json), and [control plane v1](../schemas/control-plane-v1.schema.json).
