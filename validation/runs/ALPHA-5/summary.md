# RunForge Alpha-5 Validation

Date: 2026-07-04

## Local validation

- pnpm typecheck: passed
- pnpm exec vitest run tests/integration/external-alpha3-cli.test.ts: passed
- pnpm test: passed
- pnpm build: passed
- pnpm demo:external-check: passed
- pnpm demo:external-failure-triage: passed
- pnpm demo:external-proposal-readiness: passed
- pnpm demo:external-code-proposal: passed
- pnpm demo:packet-inspect: passed

## Black-box evidence

Raw packets are under /tmp/runforge-alpha5-*.

- Import path rewrite: proposal_ready_verified, strategy typescript_import_path_rewrite, verified true, files src/app.js.
- Config literal mismatch: proposal_ready_verified, strategy config_literal_mismatch, verified true, files config/app.json.
- Ambiguous import path: no_safe_proposal, strategy null, patch bytes 0.
- Original repo status files are empty for import, config, and ambiguous cases.
- Packet inspector rendered code proposal Mermaid plus check, triage, and readiness text views.

## Notes

The deterministic proposal engine remains intentionally narrow. Ambiguous evidence falls back to no_safe_proposal.
