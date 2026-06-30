# DATA-W-2604 / RUNFORGE-REAL-LOG-DATASET-01 Summary

Prepared 10 real sanitized failure cases for RunForge validation.

## Artifacts

- Case files: `tests/fixtures/runforge/failure-cases/real-log-dataset-01/`
- Case index: `tests/fixtures/runforge/failure-cases/real-log-dataset-01/README.md`

## Coverage

- 3 test failures.
- 2 typecheck/build failures.
- 2 env/config/dependency failures.
- 1 infra/timeout failure.
- 2 other real failures.

## Guardrails

- RunForge product code was not changed.
- Buildkite/GitHub integration code was not added.
- Secrets, raw tokens, `.env` values, private keys and raw secret-bearing logs were not stored.
- Excerpts are bounded and sanitized.

## Module Coverage Decision

- Primary module: `platform-data` / DATA-W-2604.
- `docs/runforge/**`: docs-only validation summary.
- `tests/fixtures/runforge/**`: intentional validation fixture namespace for RunForge real-log classification cases; module card coverage is `needs verification` because this fixture family is new and not product runtime code.
- Contracts changed: none.

## Source Gap

The repository contains Buildkite lane documentation and migration analysis, but no direct saved Buildkite failed log excerpts in this worktree. RF-REAL-007 uses the real GitHub Actions billing block and Buildkite migration evidence rather than fabricating a Buildkite-only failed log.
