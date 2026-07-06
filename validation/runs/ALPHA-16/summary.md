# RunForge Alpha-16 Validation

Alpha-16 adds explicit disposable-workspace setup/preflight support for external check packets.

## Covered behavior

- `external check --setup-command` runs setup commands only in the disposable workspace before main commands.
- Repeated setup commands are supported.
- Main commands are skipped by default when setup fails or times out.
- Setup output is recorded in `setup-results.json` and `logs/setup-001.*`.
- Summary, run, events, metrics, safety report, trajectory, and manifest artifacts include setup phase evidence.
- Safety reports record user-provided setup commands, network uncertainty, no original repo mutation, no push, no merge, no deploy, and no apply to original repo.
- Setup failure triage uses setup logs and returns dependency/environment context, not source proposal readiness.
- Proposal readiness returns `needs_more_context` for setup failures.
- Code proposal refuses setup-failure cases with `not_ready`.

## Evidence

- Executable validation: `scripts/alpha16-validation.ts`
- Scenario evidence: `validation/runs/ALPHA-16/results.json`
- Focused integration coverage: `tests/integration/external-check-cli.test.ts`
- Demo command: `pnpm demo:external-check-setup`

## Result

Alpha-16 validation: passed.
