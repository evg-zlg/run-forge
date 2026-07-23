# Factory VPS remote executor

RunForge selects the remote route with `execution.executor: "factory-vps"`.
The remote executor ID is `runforge-factory-vps`; it uses protocol
`runforge-factory-vps/v1` over a deliberately opt-in SSH stdio bridge; the
local control plane remains loopback-only and never receives provider keys.

## Current VPS topology

The sanctioned path is the existing `factory-vps` SSH account to the VPS.  The
VPS runs Factory Loop on loopback (`127.0.0.1:3300`) with an API, runner,
repo-worker, heartbeat reaper and Factory-owned artifact storage. Its deployed
repo-task contract is safe for allowlisted clone-and-validate workloads; the
RunForge bridge is supplied by Factory PR #169 and is not deployed yet. Do not
use its controller/executor tokens on a Mac.

## Roadmap status — `FACTORY-RUNFORGE-REMOTE-BRIDGE-1`

The local RunForge contract and fail-closed routing integration are implemented.
On 2026-07-24 00:52 +05, `tests/unit/factory-vps-contract.test.ts` (4 tests)
and `pnpm typecheck` passed. A full `pnpm test` is currently blocked before
Vitest by `check:structure`: the modified `src/product/task-spec-runner.ts` is
839 lines, over the enforced 350-line limit. The bridge change therefore cannot
yet claim a full-suite-green RunForge worktree; the earlier 16 integration-test
failures must be rechecked once the structural gate passes.

Factory PR [#169](https://github.com/deskbuilder/factory/pull/169) is open on
`codex/runforge-factory-vps-bridge-1` at
`3b500bb0a9e8e807ae460f29bd806ef1605bc1dc`; its Buildkite run is pending. The
local Factory checkout has no PR #169 worktree and does not yet contain that
commit, while the remote branch resolves to it. RunForge keeps `factory-vps`
unavailable until a version-compatible bridge handshake succeeds and does not
fall back to a local executor. The current read-only readiness probe reached the
sanctioned SSH host and Factory health endpoint, then found no
`runforge-factory-vps` command, confirming that the VPS bridge is not installed
yet.

Next step: restore the local structural gate and rerun the full RunForge suite;
in parallel, continue monitoring Factory CI. After the Factory CI run is green,
an owner must authorize deploying that external-project bridge to the Factory
VPS. Only then may a real remote dogfood task be started; neither action is
performed from this repository.

## Bridge contract

Install a VPS-local command named `runforge-factory-vps`. It accepts one
versioned JSON request on stdin and writes one JSON response on stdout. Its
allowed operations are:

```text
`capabilities`, `dispatch`, `status`, `cancel`, `retry`, `result`,
`artifact-manifest`, and `artifact-read`.
```

The bridge must use its own Factory/API/provider credentials internally and
must emit JSON only. Configure the local side with
`RUNFORGE_FACTORY_VPS_SSH_HOST=factory-vps`; optionally set
`RUNFORGE_FACTORY_VPS_BRIDGE`. No password, token, `Authorization` header or
provider key is valid in the envelope.

`capabilities` returns executor/runtime identity, health, modes, provider/model
readiness (boolean only), limits, network policy, cancellation/heartbeat/
recovery support and usage-telemetry support. A version or executor-ID mismatch
is rejected before dispatch. Until this bridge is deployed, discovery and
`/readyz` advertise `runforge-factory-vps` as `unavailable`, rather than falling back to
the local coding agent.

## Transfer and artifacts

The envelope supports Git SHA, content-addressed bundle, patch/checkpoint, and
artifact-only source modes. Source path entries are relative, allowlisted,
hashed and bounded; `.env`, Git metadata, credential paths and key files are
rejected. Remote workspaces are ephemeral.

Returned artifacts must be redacted, relative-path-only, size-bounded and have
SHA-256 digests. RunForge verifies the manifest and any supplied inline content
before persistence. The bridge must report usage/cost receipts as data only,
never raw provider responses or secrets.

## Security and rollout

SSH host-key authentication is the transport boundary. The bridge must enforce
nonce/idempotency by `{taskId, attempt, generation, nonce}`, deadline and
heartbeat tracking, argv-only allowlisted commands, remote cleanup, no target
main mutation, no force push, and no deploy/DB/prod/secrets authority. A lost
heartbeat, cancellation, bridge restart, duplicate dispatch, late result,
corrupt or oversized artifact must each fail closed and surface a remote-only
recovery action.

The protocol module is covered by `tests/unit/factory-vps-contract.test.ts`.
Factory PR #169 supplies the bridge and authenticated Factory API packet
mapping; a real remote implementation or dogfood run remains blocked until that
PR is deployed to the VPS.
