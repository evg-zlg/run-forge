# Factory VPS remote executor

RunForge selects the remote route with `execution.executor: "runforge-factory-vps"`.
The remote executor ID is `runforge-factory-vps`; it uses protocol
`runforge-factory-vps/v1` over a deliberately opt-in SSH stdio bridge; the
local control plane remains loopback-only and never receives provider keys.

## Current VPS topology

The sanctioned path is the existing `factory-vps` SSH account to the VPS.  The
VPS runs Factory Loop on loopback (`127.0.0.1:3300`) with an API, runner,
repo-worker, heartbeat reaper and Factory-owned artifact storage. Its deployed
repo-task contract is safe for allowlisted clone-and-validate workloads; merged
Factory PRs #169, #170 and #171 supply the RunForge bridge inside
`runforge-bridge-worker`.
Do not use its controller/executor tokens on a Mac.

## Roadmap status — `FACTORY-RUNFORGE-REMOTE-BRIDGE-1`

The local RunForge contract and fail-closed routing integration are implemented.
On 2026-07-24, the full `pnpm test` suite passed (72 files, 714 tests), as did
typecheck and the structural gate. The local provider runner now has bounded
preflight, streamed durable progress/checkpoints, an early-progress deadline,
redacted provider artifacts, and separate implementation/review accounting.

Factory PR [#169](https://github.com/deskbuilder/factory/pull/169) merged at
`41fdd27ba857eb77809060b94df87392bbc1a002`, #170 at
`5ab272782ef86fb9dd7812bd0b043396691e44d5`, and #171 at
`1c21460848e4f443090eac024b29a07c635c00c6`. The last SHA is deployed on the
only Factory VPS. Its SSH-stdio handshake is `ready`, is SHA-bound to that
revision, advertises the four configured VPS provider identities, and confirms
cancellation, recovery, and usage telemetry. Factory Loop remains healthy and
listens only on `127.0.0.1:3300`. The host-level command is absent by design:
the transport invokes `/app/dist/scripts/runforge-factory-vps.js` in the private
worker container. The remaining roadmap action is synthetic end-to-end dogfood.

## Bridge contract

The private worker command accepts one versioned JSON request on stdin and
writes one JSON response on stdout. Its allowed operations are:

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
Merged Factory PRs #169–#171 supply the deployed bridge and SHA-bound runtime
identity. Remote dogfood uses only the existing VPS provider credentials.
