# Getting started for a new agent session

RunForge is a localhost-only control plane. If all you know is its URL, use the ordered HTTP bootstrap in [Using RunForge from another agent session](USING_RUNFORGE_FROM_ANOTHER_AGENT.md). Responsibility profiles, all 22 phases, negotiation rules, and result semantics are canonical in [Execution Agreements](EXECUTION_AGREEMENTS.md); this page is only the short operating checklist.

## Bootstrap checklist

1. `GET /.well-known/runforge`, then `GET /v1/capabilities`; use the advertised routes and schemas.
2. `POST /v1/projects/inspect` with the absolute checkout path. Set `register: true` when later requests should use its returned `project.id`; `false` performs readiness inspection only.
3. Translate the user's intent into an Execution Agreement and inspect the returned `status`, `conflicts`, `handoffs`, and phase owners:

   - `Только помоги разобраться` / `Just help me understand` means `assist-only`.
   - `Сделай локально и передай мне` / `Do it locally and hand it back to me` means `local-ready`.
   - `Доведи до готового PR` / `Take it to a ready PR` means `draft-pr`.

   These are honest intent mappings, not authority grants. For standalone `POST /v1/execution-agreements/negotiate`, send an explicit phase-keyed `authority` allowlist: `true` for every requested phase owned by RunForge and `false` for dangerous or unrequested phases. The complete `executionAgreements.minimalRequest` returned by capabilities is the directly negotiable `assist-only` starting point. `assist-only` stops before RunForge-owned Git handoff, `local-ready` asks RunForge for a bounded local branch and commit, and `draft-pr` asks for push, draft PR/MR, and CI responsibility that the current installation cannot perform.
4. Submit TaskSpec v2 either with the accepted `agreementId` and the matching `taskSpec.executionAgreement`, or omit both to request conservative mode-based auto-negotiation. Never reference a conflicted agreement.
5. Poll `GET /v1/tasks/{id}` every 1–2 seconds. Fetch `GET /v1/tasks/{id}/result` after a terminal or owner-gated state and inspect `agreement`, `handoff`, and `next` as well as the lifecycle status.
6. Perform only phases owned by your party. If `next.party` is `external_session`, follow `next.exactAction` and preserve the requested evidence. If an owner gate is advertised, record exactly that decision and call `/continue` only when instructed. Never invent approval or broaden authority on retry.

Before implementation, require a compatible `implementationExecutors[]` entry with `status: "ready"`. Health alone is insufficient. Negotiation phase authority does not grant task execution authority: TaskSpec authority and the task submission's request-level provider, network, branch, and commit gates must separately agree with the negotiated phase ownership.

## Hard adapter boundary

Current GitHub and GitLab push and PR/MR create/update adapters are unavailable. Existing-change update, CI monitoring/repair, merge, deploy, database, production, and secret adapters are also unavailable. Therefore normal `draft-pr` and delivery agreements conflict when those phases are assigned to RunForge, regardless of boolean authority. An explicitly named `external_session` must perform remote publication; RunForge never silently escalates authority.

For an existing local branch, negotiate `publicationTarget: { "kind": "existing_branch", "branchName": "work/task-1" }`; this suppresses branch creation but proves neither existence nor push authority. For an existing PR/MR, use `externally_managed_existing_change` and name its responsible external party. `existing_change` requests RunForge handling and currently conflicts because there is no update adapter. See [Execution Agreements](EXECUTION_AGREEMENTS.md#project-aware-publication-targets) for the exact target forms.

## CLI alternative

When no control-plane service is running, the local CLI remains available:

```bash
runforge onboarding --repo /absolute/path/to/project --working-directory . --format json
runforge doctor --repo /absolute/path/to/project --working-directory . --runtime local --dependency-preparation if-needed --format json
runforge task-run start --spec /absolute/path/to/task.runforge.json
```

From the RunForge source checkout, use `corepack pnpm dev --` in place of `runforge`. TaskSpec v2 is defined by [task-spec-v2.schema.json](../schemas/task-spec-v2.schema.json), and normalized results by [task-result-v1.schema.json](../schemas/task-result-v1.schema.json).
