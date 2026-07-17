# Using RunForge from another agent session

RunForge exposes a persistent, localhost-only HTTP control plane. A product-project session can discover capabilities, register its checkout, submit TaskSpec v2, poll durable state, and record explicit decisions without entering the RunForge checkout or knowing its CLI layout.

## Start and stop

```bash
runforge control-plane start
runforge control-plane status
runforge control-plane stop
```

For foreground development use `corepack pnpm dev -- control-plane serve`. The default URL is `http://127.0.0.1:7373`; state is stored atomically under `~/.runforge/control-plane`. The service refuses non-loopback binds. On restart, in-flight tasks become `interrupted` with an owner gate; success is never inferred.

## Bootstrap prompt for a product session

```text
Use the RunForge control plane at http://127.0.0.1:7373.
Do not enter or inspect the RunForge repository and do not invoke its CLI.
First GET /.well-known/runforge and /v1/capabilities.
Then POST /v1/projects/inspect with this project's absolute checkout path and working directory.
Submit a TaskSpec v2 to POST /v1/tasks with an explicit authority object.
Poll GET /v1/tasks/{id}; read GET /v1/tasks/{id}/result when ready.
Treat implementation, local branch/commit, remote push, draft publication, merge, and deploy as separate authorities.
Never infer approval. Use owner-decisions and continue only after an explicit owner decision.
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

Contracts: [TaskSpec v2](../schemas/task-spec-v2.schema.json), [task result v1](../schemas/task-result-v1.schema.json), and [control plane v1](../schemas/control-plane-v1.schema.json).
