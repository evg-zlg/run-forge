# Getting started for a new agent session

1. Run onboarding JSON.
2. Run doctor JSON for the target repository.
3. Create TaskSpec v2.
4. Start the task.
5. Read only `results.json` and `summary.md` first.
6. Stop only on a real owner gate reported by `results.json`.

RunForge is a local CLI, not a remote service. You do not need to inspect its internal code or choose between legacy rails.

```bash
runforge onboarding --repo /absolute/path/to/project --format json
runforge doctor --repo /absolute/path/to/project --runtime docker --format json
runforge task-run start --spec /absolute/path/to/task.runforge.json
```

When running from the source checkout, use `corepack pnpm dev` in place of `runforge`.

## Minimal TaskSpec v2

```json
{
  "schemaVersion": 2,
  "taskId": "PROJECT-CHECK-1",
  "task": {
    "text": "Validate the project without changing it.",
    "goal": "Produce reproducible readiness evidence.",
    "acceptanceCriteria": [
      "All safe validation commands run",
      "The target HEAD and worktree remain unchanged"
    ]
  },
  "target": { "repository": "/absolute/path/to/project" },
  "runtime": { "preference": "docker", "prepareDependencies": true },
  "validation": { "mode": "auto", "commands": [] },
  "authority": { "profile": "read-only", "allowProviderCalls": false },
  "git": { "publication": "none" },
  "merge": { "policy": "never" },
  "deploy": { "policy": "never" }
}
```

Use `validation.mode: "explicit"` with a non-empty command list if doctor cannot discover commands. Artifact output defaults to a sibling `.runforge-artifacts/<project>/<task-id>` directory and is rejected if it resolves inside the target. An existing output is replaced only when it contains an identical normalized TaskSpec.

The full contract is [task-spec-v2.schema.json](../schemas/task-spec-v2.schema.json). Unknown fields and unsupported versions are errors. Runtime provider calls, secrets, target-main writes, PR merge, deploy, DB, and production access are denied by default.

## Reading the result

`results.json` follows [task-result-v1.schema.json](../schemas/task-result-v1.schema.json) and reports the task ID, status, target path and SHAs, changed flag, completed work, validations, artifacts, Git publication data, owner gate, next action, safety assertions, errors, and limitations. `summary.md` is its human entry point.

If `ownerGate.status` is `awaiting_owner_decision`, use the exact owner-decision and continuation commands from onboarding. Do not invent approval. Otherwise follow `nextAction.recommendation`.

## Project-local defaults

`runforge onboarding --repo /path --write-project-file` creates `RUNFORGE.md` only when explicitly requested. It contains project-specific validation, authority, artifact, CI, merge/deploy, and gate defaults. The command refuses to overwrite an existing file and never commits it.

Supported today: local CLI, discovery/readiness, Docker-isolated external validation, bounded repair rails, explicit owner decisions, and normalized artifacts. Not supported: HTTP/remote/MCP/queue transports, deploy, or automatic target PR merge.
