# RunForge Alpha-4 Validation

Branch: `codex/runforge-alpha4-proposal-trace`

## Local validation

- `pnpm typecheck` passed.
- `pnpm test` passed: 9 files, 80 tests.
- `pnpm build` passed.
- `pnpm demo:external-check` passed.
- `pnpm demo:external-failure-triage` passed.
- `pnpm demo:external-proposal-readiness` passed.
- `pnpm demo:external-code-proposal` passed.

## Black-box validation

Run from `/tmp` using `pnpm --dir /Users/evgeny/Documents/projects/RunForge dev external code-proposal`.

Raw packets:

- `/tmp/runforge-alpha4-existing/packet`
- `/tmp/runforge-alpha4-literal/packet`
- `/tmp/runforge-alpha4-export/packet`
- `/tmp/runforge-alpha4-ambiguous/packet`
- `/tmp/runforge-alpha4-not-ready/packet`
- `/tmp/runforge-alpha4-verification-failed/packet`

Observed outcomes:

- Existing Alpha-3 fixture: `proposal_ready_verified`, strategy `alpha3_calculator_assertion_fixture`.
- Literal mismatch fixture: `proposal_ready_verified`, strategy `test_assertion_literal_mismatch`.
- TypeScript missing export fixture: `proposal_ready_verified`, strategy `typescript_missing_export_alias`.
- Ambiguous typecheck failure: `no_safe_proposal`.
- Not-ready dependency failure: `not_ready`.
- Verification failure fixture: `verification_failed`, reviewer decision `rejected_verification_failed`.

All proposal cases kept original repositories unchanged. Worker notes and graph-ready worker roles were present in packet trajectories.
