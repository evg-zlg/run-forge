# Validation Summary

- Total cases: 5
- Source mix: real: 0, fixture: 3, placeholder: 2
- Case categories: typecheck_failure: 1, test_failure: 1, env_config_failure: 1, dependency_failure: 1, build_failure: 1
- Validated coverage, excluding placeholders: 3/5

## Metrics By Source

### Real logs

- Cases: 0
- Root cause score average: 0.00
- Evidence score average: 0.00
- Safe command score average: 0.00
- Honesty score average: 0.00
- Security pass/fail count: 0 pass / 0 fail
- Useful report rate: 0/0

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

## Cases

- case-001: TypeScript return type mismatch (typecheck_failure, fixture)
- case-002: Vitest assertion mismatch (test_failure, fixture)
- case-003: Missing DATABASE_URL configuration (env_config_failure, fixture)
- case-004: Outdated pnpm lockfile (dependency_failure, placeholder)
- case-005: Build cannot resolve local module (build_failure, placeholder)
