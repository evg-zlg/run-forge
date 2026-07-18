# Using RunForge from another agent session

This is the concise localhost bootstrap. The responsibility model, phase table, conflict rules, publication targets, recovery behavior, and result semantics are canonical in [Execution Agreements](EXECUTION_AGREEMENTS.md). Do not duplicate or override that contract in a calling-agent prompt.

RunForge binds to loopback; the default URL is `http://127.0.0.1:7373`. A caller needs no RunForge checkout or CLI knowledge.

## 1. Discover the live contract

```bash
BASE=http://127.0.0.1:7373

curl -fsS "$BASE/.well-known/runforge"
curl -fsS "$BASE/v1/capabilities"
curl -fsS "$BASE/schemas/control-plane-v1.schema.json"
curl -fsS "$BASE/schemas/task-spec-v2.schema.json"
curl -fsS "$BASE/schemas/execution-agreement-v1.schema.json"
curl -fsS "$BASE/schemas/task-result-v1.schema.json"
```

Use the routes advertised by discovery. Before implementation, require a compatible `implementationExecutors[]` entry whose `status` is `ready`; also inspect runtime support. `/healthz` describes service health and `/readyz` describes acceptance readiness, but neither grants task authority.

## 2. Inspect and register the checkout

`register: false` is a readiness-only inspection. Use `true` to obtain a durable project ID for negotiation and submission:

```bash
REPO=/absolute/path/to/project
REGISTRATION=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg path "$REPO" \
    '{path:$path,workingDirectory:".",register:true,dependencyPreparation:"if-needed"}')" \
  "$BASE/v1/projects/inspect")
PROJECT_ID=$(printf '%s' "$REGISTRATION" | jq -er '.project.id')
printf '%s' "$REGISTRATION" | jq '{project,readiness}'
```

The registered checkout supplies source HEAD/branch and project policy context. Keep the readiness report; registration is not proof that an implementation executor is ready.

## 3. Negotiate responsibility

Bootstrap phrases map to profiles as follows:

| User phrase | Useful English equivalent | Profile | Honest boundary |
| --- | --- | --- | --- |
| `Только помоги разобраться` | `Just help me understand` | `assist-only` | RunForge can analyze and prepare a patch package; the calling session owns independent review and Git handoff/publication. |
| `Сделай локально и передай мне` | `Do it locally and hand it back to me` | `local-ready` | RunForge owns bounded local work through branch and commit; the calling session owns remote publication and review. |
| `Доведи до готового PR` | `Take it to a ready PR` | `draft-pr` | Requests push, draft PR/MR, and CI responsibility; current missing adapters make the normal preset conflict. |

The phrase selects intent only. It does not grant provider, network, Git, publication, merge, or deploy authority. Always inspect the returned agreement.

`publicationTarget: { "kind": "none" }` makes `assist-only`, `local-ready`, and `custom` local-only for push, draft publication, and CI. It never converts `draft-pr` or `delivery` into an adapter-ready local profile; those profiles keep their remote responsibilities and conflict while the adapters are unavailable.

For a local implementation handoff, negotiate `local-ready` with no remote publication target:

```bash
NEGOTIATION=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" \
    '{schemaVersion:1,profile:"local-ready",projectId:$projectId,publicationTarget:{kind:"none"}}')" \
  "$BASE/v1/execution-agreements/negotiate")
AGREEMENT_ID=$(printf '%s' "$NEGOTIATION" | jq -er \
  'select(.status == "ready") | .agreementId')
printf '%s' "$NEGOTIATION" | jq '{agreementId,profile,status,conflicts,handoffs}'
```

If responsibility must differ from a preset, negotiate `custom`. Omitted custom phases are unrequested; this example assigns analysis to RunForge and implementation to the calling session:

```bash
CUSTOM=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" \
    '{schemaVersion:1,profile:"custom",projectId:$projectId,publicationTarget:{kind:"none"},requestedOwnership:{taskAnalysis:"runforge",implementation:"external_session",localBranch:"external_session",localCommit:"external_session"}}')" \
  "$BASE/v1/execution-agreements/negotiate")
printf '%s' "$CUSTOM" | jq '{agreementId,profile,status,conflicts,handoffs}'
```

Do not submit a referenced task unless `status` is `ready`. A `conflicted` agreement produces HTTP 409 and no task. Caller-supplied capability, policy, or authority maps can only narrow installed capability; they cannot manufacture an adapter.

## 4. Submit by agreement reference

The TaskSpec must repeat the referenced profile (and, for `custom`, the same phase ownership). This exact request executes the ready `local-ready` agreement without requesting remote publication:

```bash
TASK_ID=PROJECT-LOCAL-1
TASK=$(curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg projectId "$PROJECT_ID" \
    --arg agreementId "$AGREEMENT_ID" \
    --arg repo "$REPO" \
    --arg taskId "$TASK_ID" \
    '{projectId:$projectId,agreementId:$agreementId,taskSpec:{schemaVersion:2,taskId:$taskId,task:{text:"Implement the bounded requested change.",goal:"Return a validated local branch and commit.",acceptanceCriteria:["The requested change is implemented","Validation evidence is recorded","A local commit is recorded"]},target:{repository:$repo,workingDirectory:"."},execution:{mode:"implementation",maxRepairIterations:2,timeoutMs:300000,maxProviderTokens:100000},executionAgreement:{schemaVersion:1,profile:"local-ready"},runtime:{preference:"local-disposable",dependencyPreparation:"if-needed",externalNetwork:"allowed"},validation:{mode:"auto",commands:[]},authority:{profile:"bounded-implementation",forbiddenAreas:[".env","secrets"],allowProviderCalls:true,allowNetwork:true},git:{publication:"none",branch:null},merge:{policy:"never"},deploy:{policy:"never"},repair:{mode:"none",plan:null}},authority:{inspect:true,implementation:true,providerCalls:true,network:true,localBranch:true,localCommit:true,remotePush:false,draftPublication:false,merge:false,deploy:false},publication:"none"}')" \
  "$BASE/v1/tasks")
printf '%s' "$TASK" | jq '{id,status,executionAgreement,selection,progress}'
```

`agreementId` and its alias `executionAgreementId` are mutually exclusive; prefer `agreementId`. Task IDs are unique, so use a new one for a new submission.

## 5. Or allow safe auto-negotiation

Omit both the top-level agreement reference and `taskSpec.executionAgreement`. RunForge persists a conservative mode default: `assist-only` for inspection/validation and `local-ready` for implementation/repair. This read-only example auto-negotiates only discovery and analysis:

```bash
TASK_ID=PROJECT-INSPECT-1
curl -fsS \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg projectId "$PROJECT_ID" --arg repo "$REPO" --arg taskId "$TASK_ID" \
    '{projectId:$projectId,taskSpec:{schemaVersion:2,taskId:$taskId,task:{text:"Inspect the registered checkout without changing it.",goal:"Return bounded local evidence.",acceptanceCriteria:["The target repository remains unchanged"]},target:{repository:$repo,workingDirectory:"."},execution:{mode:"inspection",timeoutMs:300000},runtime:{preference:"docker",dependencyPreparation:"if-needed",externalNetwork:"denied"},validation:{mode:"explicit",commands:["git diff --check"]},authority:{profile:"read-only",allowProviderCalls:false,allowNetwork:false},git:{publication:"none",branch:null},merge:{policy:"never"},deploy:{policy:"never"},repair:{mode:"none",plan:null}},authority:{inspect:true,implementation:false,providerCalls:false,network:false,localBranch:false,localCommit:false,remotePush:false,draftPublication:false,merge:false,deploy:false},publication:"none"}')" \
  "$BASE/v1/tasks"
```

Use this example only when capabilities report Docker available. Auto-negotiation is conservative, not an authority shortcut: implementation still requires all TaskSpec and request-level implementation, provider, network, branch, and commit gates.

## 6. Poll, read the result, and hand off

```bash
curl -fsS "$BASE/v1/tasks/$TASK_ID"
curl -fsS "$BASE/v1/tasks/$TASK_ID/agreement"
curl -fsS "$BASE/v1/tasks/$TASK_ID/result"
```

Poll the task every 1–2 seconds. While active, read `progress.phase`, `progress.operation`, `progress.lastHeartbeatAt`, `progress.workerStatus`, `progress.deadlineAt`, and `progress.agreement`. `/result` returns `result_not_ready` until result evidence exists.

At completion, read the result's `agreement`, `handoff`, and `next` objects. `runforge_scope_completed` is not end-to-end completion. If `next.party` is `external_session`, perform only `next.exactAction` and retain the requested evidence; do not infer a push, PR/MR, CI result, merge, or deploy from a local branch or commit. If the task advertises an owner gate, post the explicit decision and continue only as directed:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data '{"decisionId":"owner-decision-1","decision":"approve","note":"Owner explicitly approved the advertised continuation."}' \
  "$BASE/v1/tasks/$TASK_ID/owner-decisions"
curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/continue"
```

On interruption, wait for `recovery.retryAvailable: true` and call only the advertised `recovery.operation`. Retry, restart, cancellation, continuation, and publication decisions preserve the agreement and never expand authority.

## Publication targets and unavailable adapters

Current GitHub/GitLab push and PR/MR create/update adapters are unavailable. So are adapters for updating an existing change, CI monitoring/repair, merge, deploy, database, production, and secrets. Normal `draft-pr` and delivery profiles therefore conflict when RunForge owns those phases. A publication decision records approval but performs no provider call; `external_session` (or another explicitly named external party) must publish.

- `{ "kind": "existing_branch", "branchName": "work/task-1" }` means another party already controls that local branch. It suppresses branch creation but proves neither branch existence nor commit/push authority.
- `{ "kind": "existing_change", "provider": "github", "changeId": "123" }` asks RunForge to push/update that PR and currently conflicts.
- `{ "kind": "externally_managed_existing_change", "provider": "gitlab", "changeId": "456", "responsibleParty": "external_session" }` delegates push/publication of that MR to the calling session; CI defaults to unrequested.

Register the actual checkout before using an existing branch or PR/MR target so negotiation captures its source state. No phrase, project file, target, decision, retry, or handoff silently escalates authority.

Contracts: [Execution Agreement v1](../schemas/execution-agreement-v1.schema.json), [control-plane v1](../schemas/control-plane-v1.schema.json), [TaskSpec v2](../schemas/task-spec-v2.schema.json), and [task result v1](../schemas/task-result-v1.schema.json).
