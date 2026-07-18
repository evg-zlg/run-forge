# Execution Agreements

An Execution Agreement answers one question before work starts: **who is responsible for each phase of this task?** It is the stable responsibility contract between RunForge, the calling local session, the owner, and any external system.

The HTTP API is public for localhost clients. It binds only to loopback, rejects non-local Host and browser Origin values, and is not a network-remote or SaaS service. A client that knows only `http://127.0.0.1:7373` can discover every route and schema from `/.well-known/runforge` and `/v1/capabilities`.

Contracts:

- [Execution Agreement v1](../schemas/execution-agreement-v1.schema.json)
- [control-plane v1 requests](../schemas/control-plane-v1.schema.json)
- [TaskSpec v2](../schemas/task-spec-v2.schema.json)
- [task result v1](../schemas/task-result-v1.schema.json)

## Choose a responsibility profile

These short phrases are useful bootstrap intent, not hidden authorization:

| Intent | Profile | Meaning |
| --- | --- | --- |
| `Только помоги разобраться` / `Just help me understand` | `assist-only` | RunForge prepares and may implement a patch package, but the calling session owns independent review and Git handoff/publication. |
| `Сделай локально и передай мне` / `Do it locally and hand it back to me` | `local-ready` | RunForge owns the bounded local branch and local commit; the calling session owns remote publication and review. |
| `Доведи до готового PR` / `Take it to a ready PR` | `draft-pr` | Requests RunForge ownership through push, draft PR/MR, and CI repair. This currently conflicts because those adapters are unavailable. |
| `Deliver it end to end` | `delivery` | Requests RunForge ownership through review, merge, deploy, and post-deploy validation. This currently conflicts at multiple hard boundaries. |
| `Use these exact owners` | `custom` | The caller supplies phase ownership explicitly; omitted phases are not requested. |

Selecting a phrase or profile does not grant authority. The negotiation response is the contract to inspect.

## Phase ownership

There are exactly 22 ordered phases:

```text
projectDiscovery → taskAnalysis → implementationPlanning → implementation
→ localValidation → independentReview → repairIterations → patchPackage
→ localBranch → localCommit → remotePush → draftPublication
→ ciMonitoring → ciRepair → prReview → merge → deploy
→ postDeployValidation → dbAccess → productionAccess → secretUse
→ providerModelCalls
```

The parties are `runforge`, `external_session`, `owner`, `external_system`, and `nobody`. `nobody` means the phase is not requested. Preset ownership is:

| Profile | RunForge owns | `external_session` owns | Owner owns | Always unrequested |
| --- | --- | --- | --- | --- |
| `assist-only` | discovery, analysis, planning, implementation, local validation, repair, patch package, provider/model calls | independent review, local branch, local commit, push, draft publication, CI monitoring/repair, PR review, merge | deploy, post-deploy validation | DB, production, secrets |
| `local-ready` | all local phases through local commit, including independent review and provider/model calls | push, draft publication, CI monitoring/repair, PR review | merge, deploy, post-deploy validation | DB, production, secrets |
| `draft-pr` | all local phases through push, draft publication, CI monitoring/repair, plus provider/model calls | PR review | merge, deploy, post-deploy validation | DB, production, secrets |
| `delivery` | all phases from discovery through post-deploy validation, plus provider/model calls | none | none | DB, production, secrets |
| `custom` | only phases explicitly assigned `runforge` | only phases explicitly assigned `external_session` | only phases explicitly assigned `owner` | every omitted phase, plus phases explicitly assigned `nobody` |

`external_system` can own any explicitly assigned custom phase. The table describes responsibility, not proof that RunForge can perform the phase.

## Negotiation algorithm

For each phase, negotiation keeps five facts separate:

1. Is it requested?
2. Who owns it?
3. Can this RunForge installation perform it?
4. Did the caller grant authority for it?
5. Does policy permit it?

A requested phase owned by RunForge is `ready` only when technical capability, authority, and policy are all true. In compact form:

```text
effective RunForge scope = requested ∩ RunForge-owned ∩ capable ∩ authorized ∩ policy-allowed
```

An external party's phase is a `handoff`, not a RunForge failure. An unrequested phase is normalized to owner `nobody` and status `not_requested`. A requested RunForge phase becomes a conflict with kind `unavailable`, `unauthorized`, or `policy_denied` when one of the three gates fails.

Caller-supplied `technicalCapability`, `authority`, and `policy` maps can only narrow installation values; they cannot enable an unavailable or forbidden capability. Project `RUNFORGE.md` is read as defaults only and has `authorityEscalationTrusted: false`. A referenced agreement must match the TaskSpec profile, requested phases, and custom ownership. RunForge never silently changes owners, downgrades a profile, or converts an implementation request to inspection.

Agreement status has a separate lifecycle:

- `ready`: requested phases are ready or delegated and no phase conflicts.
- `conflicted`: at least one RunForge-owned requested phase is unavailable, unauthorized, or policy-denied. Task submission returns HTTP 409 `execution_agreement_conflict` and creates no task.
- `in_progress`: at least one requested phase has completion evidence and some requested work remains.
- `completed`: every requested phase has completion evidence.

Negotiation produces a stable `ea_v1_…` ID from the contract data. Repeating the same negotiation context produces the same ID.

### TaskSpec mode limits

At task submission, RunForge narrows the requested phases to the execution mode:

- `inspection`: `projectDiscovery` and `taskAnalysis` only.
- `validation`: discovery, analysis, and `localValidation` only.
- `implementation` and `repair`: profile/custom ownership applies; `providerModelCalls` is omitted when TaskSpec does not allow provider calls.

If an older TaskSpec v2 omits `executionAgreement`, safe defaults apply: `assist-only` for inspection/validation and `local-ready` for implementation/repair. Other omissions remain conservative: TaskSpec authority defaults to `read-only`, provider calls and network to false, runtime external network to `denied`, Git publication to `none`, merge/deploy to `never`, owner gating to `stop-and-report`, and repair to `none`. Dependency preparation defaults to `if-needed`; legacy `prepareDependencies: true|false` maps to `required|disabled`. The control-plane request defaults to `inspect: true` and every mutation/publication authority false. These defaults do not make an implementation request executable: the local coding-agent lane still requires explicit TaskSpec and request-level implementation, provider, network, local-branch, and local-commit authority.

## Current adapter limits

The capability response is authoritative. Today these adapters are explicitly unavailable:

- GitHub push and pull-request create/update;
- GitLab push and merge-request create/update;
- update of any existing PR, MR, or other change;
- CI monitoring or repair;
- merge and deploy;
- database and production access;
- secret access (credentials are never returned).

Consequently, normal `draft-pr` and `delivery` negotiations are `conflicted`; granting booleans cannot manufacture an adapter. A publication decision is durable but performs no provider call. An `external_session` (or another explicitly named external party) must push and publish. RunForge never merges or deploys through this API.

Provider/model calls for local implementation are different from publication adapters. They are available only when `/v1/capabilities` reports a ready implementation executor with an existing credential mechanism and when both TaskSpec and request authority allow provider transport and network access.

## Project-aware publication targets

Negotiation can bind the agreement to a registered project. Its context records repository, working directory, current HEAD/branch, detached-HEAD state, default/protected branches, policy sources, and one publication target:

| Target | Negotiation meaning |
| --- | --- |
| `{ "kind": "none" }` | Remote push, draft publication, and CI phases are not requested. This is the safe default. |
| `{ "kind": "new_branch", "branchName": "runforge/task-1" }` | Requests `localBranch`; the chosen owner must create that new local branch. |
| `{ "kind": "existing_branch", "branchName": "work/task-1" }` | Suppresses branch creation. It does not prove that the branch exists or authorize a commit/push. |
| `{ "kind": "existing_change", "provider": "github", "changeId": "123" }` | Requests remote push and draft publication/update. RunForge-owned handling conflicts because no existing-change adapter exists. |
| `{ "kind": "externally_managed_existing_change", "provider": "gitlab", "changeId": "456", "responsibleParty": "external_session" }` | Requests remote push/publication but delegates both to the named external party; CI monitoring/repair default to unrequested. |

For an existing branch, PR, or MR, first register the actual checkout so the agreement captures its source state. Use `existing_branch` only when another party already controls the local branch. Use `externally_managed_existing_change` for an existing PR/MR and name `external_session`, `external_system`, or `owner`; that party must perform and report publication. `existing_change` does not enable RunForge to update it.

## Local HTTP flow

Start the installed service with `runforge control-plane start`, or run this checkout in the foreground:

```bash
corepack pnpm dev -- control-plane serve
```

All POST bodies use `content-type: application/json` and are limited to 1 MiB by default. The examples below use the default URL and `jq` only to carry returned IDs safely.

### 1. Discover capabilities and schemas

```bash
BASE=http://127.0.0.1:7373

curl -fsS "$BASE/.well-known/runforge"
curl -fsS "$BASE/v1/capabilities"
curl -fsS "$BASE/schemas/control-plane-v1.schema.json"
curl -fsS "$BASE/schemas/task-spec-v2.schema.json"
curl -fsS "$BASE/schemas/execution-agreement-v1.schema.json"
curl -fsS "$BASE/schemas/task-result-v1.schema.json"
```

Before implementation, require a compatible `implementationExecutors[]` entry with `status: "ready"`. Before any runtime, inspect `execution.runtimeSupport`. Do not infer readiness from HTTP health alone.

### 2. Register a project

Request JSON:

```json
{
  "path": "/absolute/path/to/project",
  "workingDirectory": ".",
  "register": true,
  "dependencyPreparation": "if-needed"
}
```

Exact curl with a shell-safe path:

```bash
REPO=/absolute/path/to/project
REGISTRATION=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg path "$REPO" '{path:$path,workingDirectory:".",register:true,dependencyPreparation:"if-needed"}')" \
  "$BASE/v1/projects/inspect")
PROJECT_ID=$(printf '%s' "$REGISTRATION" | jq -r '.project.id')
```

The response is `{ "project": <record-or-null>, "readiness": <doctor-report> }`. Registration succeeds only when `project` contains an ID; keep the full readiness report.

### 3. Negotiate a preset

This preset asks only for read-oriented discovery and analysis, avoiding accidental implementation or publication:

```json
{
  "schemaVersion": 1,
  "profile": "assist-only",
  "projectId": "prj_0123456789abcdef",
  "publicationTarget": { "kind": "none" },
  "requested": {
    "implementationPlanning": false,
    "implementation": false,
    "localValidation": false,
    "independentReview": false,
    "repairIterations": false,
    "patchPackage": false,
    "localBranch": false,
    "localCommit": false,
    "prReview": false,
    "merge": false,
    "deploy": false,
    "postDeployValidation": false,
    "providerModelCalls": false
  }
}
```

```bash
PRESET=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" '{schemaVersion:1,profile:"assist-only",projectId:$projectId,publicationTarget:{kind:"none"},requested:{implementationPlanning:false,implementation:false,localValidation:false,independentReview:false,repairIterations:false,patchPackage:false,localBranch:false,localCommit:false,prReview:false,merge:false,deploy:false,postDeployValidation:false,providerModelCalls:false}}')" \
  "$BASE/v1/execution-agreements/negotiate")
printf '%s' "$PRESET" | jq '{agreementId,profile,status,conflicts,handoffs}'
```

Always require `status == "ready"` before referencing the agreement.

### 4. Negotiate a custom external handoff

This coherent custom request delegates implementation and its local Git result to the calling session. RunForge only analyzes the task:

```json
{
  "schemaVersion": 1,
  "profile": "custom",
  "projectId": "prj_0123456789abcdef",
  "publicationTarget": { "kind": "none" },
  "requestedOwnership": {
    "taskAnalysis": "runforge",
    "implementation": "external_session",
    "localBranch": "external_session",
    "localCommit": "external_session"
  },
  "prerequisites": {
    "implementation": ["Use the registered project and accepted task scope"]
  },
  "completionEvidence": {}
}
```

```bash
CUSTOM=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" '{schemaVersion:1,profile:"custom",projectId:$projectId,publicationTarget:{kind:"none"},requestedOwnership:{taskAnalysis:"runforge",implementation:"external_session",localBranch:"external_session",localCommit:"external_session"},prerequisites:{implementation:["Use the registered project and accepted task scope"]},completionEvidence:{}}')" \
  "$BASE/v1/execution-agreements/negotiate")
AGREEMENT_ID=$(printf '%s' "$CUSTOM" | jq -r '.agreementId')
printf '%s' "$CUSTOM" | jq '{agreementId,profile,status,conflicts,handoffs}'
```

### 5. Read and reference an agreement

```bash
curl -fsS "$BASE/v1/execution-agreements/$AGREEMENT_ID"
```

A task references it with the top-level `agreementId` (the alias `executionAgreementId` is accepted, but never send both). The TaskSpec must repeat the matching profile and custom phase ownership:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" --arg agreementId "$AGREEMENT_ID" --arg repo "$REPO" '{projectId:$projectId,agreementId:$agreementId,taskSpec:{schemaVersion:2,taskId:"PROJECT-HANDOFF-1",task:{text:"Prepare an explicit implementation handoff.",goal:"The calling session receives scoped responsibility.",acceptanceCriteria:["Responsibility and next evidence are explicit"]},target:{repository:$repo,workingDirectory:"."},execution:{mode:"implementation",maxProviderTokens:100000},executionAgreement:{schemaVersion:1,profile:"custom",phaseOwnership:{taskAnalysis:"runforge",implementation:"external_session",localBranch:"external_session",localCommit:"external_session"}},runtime:{preference:"local-disposable",dependencyPreparation:"if-needed",externalNetwork:"denied"},validation:{mode:"explicit",commands:["git diff --check"]},authority:{profile:"bounded-implementation",allowProviderCalls:false,allowNetwork:false},git:{publication:"none",branch:null},merge:{policy:"never"},deploy:{policy:"never"},repair:{mode:"none",plan:null}},authority:{inspect:true,implementation:false,providerCalls:false,network:false,localBranch:false,localCommit:false,remotePush:false,draftPublication:false,merge:false,deploy:false},publication:"none"}')" \
  "$BASE/v1/tasks"
```

Because implementation is owned by `external_session`, RunForge selects the `agreement-handoff` lane and does not invoke a coding agent. The TaskSpec still uses the bounded-implementation profile because its execution mode is `implementation`; no implementation authority is inferred for RunForge.

### 6. Submit an auto-negotiated TaskSpec

If `executionAgreement` is omitted, RunForge creates and persists the safe mode default. This inspection example auto-negotiates `assist-only` and requests only discovery and analysis:

```json
{
  "projectId": "prj_0123456789abcdef",
  "taskSpec": {
    "schemaVersion": 2,
    "taskId": "PROJECT-INSPECT-1",
    "task": {
      "text": "Inspect the registered project without changing it.",
      "goal": "Produce bounded local evidence.",
      "acceptanceCriteria": ["The target repository remains unchanged"]
    },
    "target": {
      "repository": "/absolute/path/to/project",
      "workingDirectory": "."
    },
    "execution": { "mode": "inspection", "timeoutMs": 300000 },
    "runtime": {
      "preference": "docker",
      "dependencyPreparation": "if-needed",
      "externalNetwork": "denied"
    },
    "validation": {
      "mode": "explicit",
      "commands": ["git diff --check"]
    },
    "authority": {
      "profile": "read-only",
      "allowProviderCalls": false,
      "allowNetwork": false
    },
    "git": { "publication": "none", "branch": null },
    "merge": { "policy": "never" },
    "deploy": { "policy": "never" },
    "repair": { "mode": "none", "plan": null }
  },
  "authority": {
    "inspect": true,
    "implementation": false,
    "providerCalls": false,
    "network": false,
    "localBranch": false,
    "localCommit": false,
    "remotePush": false,
    "draftPublication": false,
    "merge": false,
    "deploy": false
  },
  "publication": "none"
}
```

Submit it only when capabilities report Docker available:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" --arg repo "$REPO" '{projectId:$projectId,taskSpec:{schemaVersion:2,taskId:"PROJECT-INSPECT-1",task:{text:"Inspect the registered project without changing it.",goal:"Produce bounded local evidence.",acceptanceCriteria:["The target repository remains unchanged"]},target:{repository:$repo,workingDirectory:"."},execution:{mode:"inspection",timeoutMs:300000},runtime:{preference:"docker",dependencyPreparation:"if-needed",externalNetwork:"denied"},validation:{mode:"explicit",commands:["git diff --check"]},authority:{profile:"read-only",allowProviderCalls:false,allowNetwork:false},git:{publication:"none",branch:null},merge:{policy:"never"},deploy:{policy:"never"},repair:{mode:"none",plan:null}},authority:{inspect:true,implementation:false,providerCalls:false,network:false,localBranch:false,localCommit:false,remotePush:false,draftPublication:false,merge:false,deploy:false},publication:"none"}')" \
  "$BASE/v1/tasks"
```

The response is HTTP 202 and includes the persisted `executionAgreement`, effective `authority`, executor `selection`, gates, and progress. Task IDs are unique; use a new ID for another submission.

### 7. Poll task and result

```bash
TASK_ID=PROJECT-INSPECT-1
curl -fsS "$BASE/v1/tasks/$TASK_ID"
curl -fsS "$BASE/v1/tasks/$TASK_ID/agreement"
curl -fsS "$BASE/v1/tasks/$TASK_ID/result"
```

Poll the task every 1–2 seconds. Fetch `/result` only after a terminal or owner-gated state; an active task returns HTTP 404 `result_not_ready` with `retryable: true`.

## Lifecycle, completion, and handoff semantics

Task lifecycle status from `GET /v1/tasks/{id}` is control-plane state:

- `queued`, `running`, `continuing`: active lifecycle states.
- `awaiting_owner_decision`: work stopped at an explicit owner gate; record a decision, then call `/continue` only when the task advertises that path.
- `completed`, `failed`, `interrupted`: terminal for the current attempt. `interrupted` may later advertise retry.

During active work, use `progress.phase`, `operation`, `executionId`, `attempt`, `lastHeartbeatAt`, `workerStatus`, `deadlineAt`, `summary`, and `diagnostic`. `progress.agreement` projects the current phase, responsible/next party, completed and delegated phases, gates, and exact next action.

Agreement-aware task-result completion status describes responsibility outcome, not worker state:

- `runforge_scope_completed`: RunForge finished its scope; another named party still owns work.
- `workflow_completed`: all requested responsibility is complete.
- `awaiting_external_session` or `awaiting_owner`: that party must act.
- `blocked_by_capability` or `blocked_by_policy`: work could not proceed honestly.
- `failed`: execution failed.

The schema also accepts legacy result statuses `completed`, `failed`, `awaiting_owner_decision`, `blocked`, `implementation_not_started`, and `no_change_required`. Read `controlPlane.status` for lifecycle and top-level `status` for completion semantics; do not treat `runforge_scope_completed` as end-to-end delivery.

An agreement-aware result contains:

- `agreement`: ID, `profile`, `requestedProfile`, `effectiveProfile`, agreement status, phase ownership, RunForge-completed phases, delegated phases, and awaiting phases. Current negotiation does not silently downgrade, so `requestedProfile` and `effectiveProfile` are equal; inspect phase ownership for the effective responsibility split.
- `handoff`: portable summary, changed files, patch, branch, commit, validation, findings, risks, publication/CI instructions, safety assertions, target/base SHA, and exact next actions.
- `next`: the next party, exact action, gates, and evidence.

`handoff.branch` and `handoff.commit` are deliberately different. A branch is a movable local ref and is required for a `local-ready` handoff; it must be `null` for `assist-only`. A commit is immutable evidence of a recorded result and is always present as a field but may be `null`. Never infer a commit from a branch name, a push from a commit, or publication from either. The safety contract keeps target-main mutation/push, PR merge, deploy, database, production, and secret access false.

## Retry, restart, and cancellation

The accepted agreement is embedded in task state and preserved across owner continuation, cancellation, interruption, retry, and control-plane restart. Its ID and authority do not expand. Each replacement attempt gets a new `progress.executionId`, increments `progress.attempt`, and uses an isolated artifact root. Late results from a revoked execution generation are ignored.

Cancellation is idempotent and produces `interrupted`; it never implies success or completed target mutation:

```bash
curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/cancel"
```

For an interrupted task, poll until `recovery.retryAvailable` is true and call only the advertised `recovery.operation`:

```bash
curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/retry"
```

During bounded old-worker cleanup, retry returns HTTP 409 `recovery_pending` with `retryAfter` and a polling action. If cleanup is detached, in-place retry remains blocked so two workers cannot overlap mutations. A restart converts in-flight work to `interrupted`; success and target mutation are not inferred. Failed or changed-precondition cases may require `start_new_task` instead of retry. Never invent a recovery action or resubmit with broader authority to make an error disappear.

No profile, owner decision, retry, restart, cancellation, publication decision, project policy file, or external handoff silently escalates authority. If a requested responsibility exceeds the capability-policy-request-authority intersection, the honest outcomes are conflict, block, handoff, or a new explicitly authorized task.
