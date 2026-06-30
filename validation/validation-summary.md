# Validation Summary

- Total cases: 15
- Source mix: real: 10, fixture: 3, placeholder: 2
- Real useful report rate: 6/10 (60%)
- Case categories: typecheck_failure: 3, test_failure: 4, env_config_failure: 1, dependency_failure: 1, build_failure: 1, unknown_failure: 4, infra_timeout_failure: 1
- Validated coverage, excluding placeholders: 13/15

## Metrics By Source

### Real logs

- Cases: 10
- Root cause score average: 2.00
- Evidence score average: 3.00
- Safe command score average: 1.60
- Honesty score average: 3.00
- Security pass/fail count: 10 pass / 0 fail
- Useful report rate: 6/10 (60%)

### Fixture logs

- Cases: 3
- Root cause score average: 3.00
- Evidence score average: 2.67
- Safe command score average: 2.33
- Honesty score average: 3.00
- Security pass/fail count: 3 pass / 0 fail
- Useful report rate: 3/3 (100%)

### Placeholder cases

- Cases: 2
- Root cause score average: 2.50
- Evidence score average: 2.50
- Safe command score average: 2.50
- Honesty score average: 3.00
- Security pass/fail count: 2 pass / 0 fail
- Useful report rate: 2/2 (100%)

## Missing Real-log Gaps

- case-004: Only three sanitized fixture logs were available locally; this dependency failure is a real-ish placeholder until a sanitized CI install log is added.
- case-005: Only three sanitized fixture logs were available locally; this build failure is a real-ish placeholder until a sanitized production build log is added.

## Weak Real Cases

- RF-REAL-006: expected env_config_dependency_failure, got unknown_failure; Current score is deterministic/heuristic and should be reviewed manually before claiming product validation.
- RF-REAL-007: expected env_config_dependency_failure, got unknown_failure; Current score is deterministic/heuristic and should be reviewed manually before claiming product validation.
- RF-REAL-009: expected real_failure_other, got unknown_failure; Current score is deterministic/heuristic and should be reviewed manually before claiming product validation.
- RF-REAL-010: expected real_failure_other, got unknown_failure; Current score is deterministic/heuristic and should be reviewed manually before claiming product validation.

## Scoring Note

Current score is deterministic/heuristic and should be reviewed manually before claiming product validation. This summary does not claim market or product validation.

## Cases

- case-001: TypeScript return type mismatch (typecheck_failure, fixture)
- case-002: Vitest assertion mismatch (test_failure, fixture)
- case-003: Missing DATABASE_URL configuration (env_config_failure, fixture)
- case-004: Outdated pnpm lockfile (dependency_failure, placeholder)
- case-005: Build cannot resolve local module (build_failure, placeholder)
- RF-REAL-001: Frontend unit guard failed two assertions after mobile runtime source moved or changed. (test_failure, real)
- RF-REAL-002: Read-only schedule-stack guard expected a source contract string that was absent on the current head. (test_failure, real)
- RF-REAL-003: First local backend unit run showed two failed suites due to Prisma loading through the Jest runtime; immediate rerun passed. (test_failure, real)
- RF-REAL-004: Typecheck failed before TypeScript analysis because the shared workspace lacked the local tsc binary. (typecheck_failure, real)
- RF-REAL-005: Preview build failed because shared dependencies were not installed before build, leaving tsc unavailable. (typecheck_failure, real)
- RF-REAL-006: Preview deploy failed because the remote DB URL template used the wrong placeholder token. (unknown_failure, real)
- RF-REAL-007: GitHub-hosted Actions were blocked by an organization billing/payment gate, forcing delivery proof to move to Buildkite lanes. (unknown_failure, real)
- RF-REAL-008: Stage smoke was cancelled after the 15 minute job timeout even though critical flows had already passed. (infra_timeout_failure, real)
- RF-REAL-009: Preview deploy built the app and passed local health, then failed because the deploy user lacked passwordless sudo for nginx config install/link operations. (unknown_failure, real)
- RF-REAL-010: PR evidence gate failed because required owner/report sections were missing from the PR body. (unknown_failure, real)
