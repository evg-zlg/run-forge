# RunForge Alpha-10 Dogfood Index

Generated at: 2026-07-05T15:30:00.000Z

Alpha-10 turns Alpha-9 external proposal dogfood into compact, queryable run evidence.

Evidence set:

- `smartsql-readme-provider-proposal`: delivered Alpha-9 evidence. Outcome `proposal_ready_verified`, provider `accepted`, touched `README.md`, SmartSQL original repo unchanged.
- `smartsql-env-provider-rejection`: delivered Alpha-9 evidence. Outcome `provider_rejected`, provider `rejected`, rejection reason `patch touches forbidden path: .env`, SmartSQL original repo unchanged.
- `smartsql-merge-intervals-real-code-proposal`: stopped-session comparison evidence from a real code proposal. Outcome `proposal_ready_verified` after correcting a provider hunk issue, touched `factory-lab/smoke-task-repo/src/intervals.py`, no manual apply, SmartSQL original repo unchanged.
- `factory-readme-provider-rejection-dry-run-apply`: stopped-session comparison evidence only. Outcome `provider_rejected`, provider `rejected`, dry-run apply failed, Factory original repo unchanged. This is not delivered accepted Alpha-9 evidence.

Index artifacts:

- `validation/runs/ALPHA-10/external-dogfood-index.json`
- `validation/runs/ALPHA-10/results.json`

CLI added:

```bash
pnpm dev packet index --root validation/runs --out /tmp/runforge-index
```

Expected outputs:

- `/tmp/runforge-index/index.md`
- `/tmp/runforge-index/index.json`

Rejected/failed proposal UX:

- Rejected and failed proposal packets now include `Operator verdict`, `Failure class`, `Reason`, and `Next action`.
- Non-verified outcomes explicitly say `Do not apply proposal.patch from this packet`.
- Dry-run apply failures, malformed diffs, forbidden paths, verification failures, not-ready packets, provider failures, and no-safe-proposal packets get distinct next actions.

Safety:

- No stopped-session branches were merged.
- No generated patches were applied to external original repos.
- No raw `/tmp` packet trees were copied into the repo.
