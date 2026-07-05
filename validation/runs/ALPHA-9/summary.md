# RunForge Alpha-9 External Dogfood

Generated at: 2026-07-05T11:45:00.000Z

Alpha-9 proved RunForge on a real external local repo: `/Users/evgeny/Documents/projects/smartsql`.

External repo safety:

- Before HEAD: `71e2c386bfc21adfae2d0101712fb42dae46e6e1`
- After HEAD: `71e2c386bfc21adfae2d0101712fb42dae46e6e1`
- Before/after status matched. Existing untracked files in `smartsql` remained unmodified by RunForge.
- RunForge produced and verified proposal packets through disposable copied workspaces only.
- No generated patch was manually applied to `smartsql`.
- No secrets, deploys, pushes, merges, or destructive commands were used.

Dogfood coverage:

- `smartsql-readme-proposal`: provider-backed proposal accepted and verified. Packet status `proposal_ready_verified`; provider status `accepted`; changed file `README.md`; original repo unchanged.
- `smartsql-provider-reject`: provider-backed unsafe `.env` patch rejected by RunForge. Packet status `provider_rejected`; provider status `rejected`; rejection reason `patch touches forbidden path: .env`; original repo unchanged.

Validation:

- `packet inspect --validate` passed for both code proposal packets.
- `packet inspect --validate --format mermaid` ran for both code proposal packets.
- `packet view` exported static viewers for both code proposal packets.
- `pnpm validation:alpha9` added as a local evidence summary/check command.
- `pnpm typecheck` passed.
- `pnpm test` passed, 101 tests.
- `pnpm validation:packets` passed.
- `pnpm build` passed.

Node 20 deprecation annotation:

- The workflow used `pnpm/action-setup@v4`, which runs on Node 20 and triggers the GitHub Actions deprecation annotation.
- Upstream `pnpm/action-setup` currently documents `@v6` in usage examples, and the Marketplace latest version is `v6.0.9`.
- CI was updated to `pnpm/action-setup@v6`.

Raw outputs:

- `/tmp/runforge-alpha9-smartsql-readme`
- `/tmp/runforge-alpha9-smartsql-provider-reject`
