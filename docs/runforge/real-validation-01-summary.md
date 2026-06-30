# RUNFORGE-REAL-VALIDATION-01 Summary

## Dataset

- Source: DATA-W-2604 / PR #2606 / commit `7e3403bef`.
- Dataset: `RUNFORGE-REAL-LOG-DATASET-01`.
- Case files: `tests/fixtures/runforge/failure-cases/real-log-dataset-01/`.
- Cases: 10 real sanitized failure cases.

## Class Distribution

- Test failures: 3.
- Typecheck/build failures: 2.
- Env/config/dependency failures: 2.
- Infra/timeout failures: 1.
- Other real failures: 2.

## Validation Command

```sh
pnpm validation:run
```

The run generated `validation/runs/RF-REAL-001/` through `validation/runs/RF-REAL-010/`, each with `review.md`, `trajectory.json`, `safety-report.json`, `context-summary.json`, and `score.json`.

## Real-case Metrics

- Real useful report rate: 6/10 (60%).
- Real average root cause score: 2.00.
- Real average evidence score: 3.00.
- Real average safe command score: 1.60.
- Real average honesty score: 3.00.
- Security for real cases: 10 pass / 0 fail.

Current score is deterministic/heuristic and should be reviewed manually before claiming product validation. This run does not claim market or product validation.

## Weak Cases

- `RF-REAL-006`: config template placeholder failure was classified as `unknown_failure` instead of env/config/dependency.
- `RF-REAL-007`: external CI provider payment gate was classified as `unknown_failure` instead of env/config/dependency.
- `RF-REAL-009`: sudo/nginx permission failure was classified as `unknown_failure`; RunForge has no permission/deploy class yet.
- `RF-REAL-010`: PR evidence gate failure was classified as `unknown_failure`; RunForge has no process-gate class yet.

## Top Failure Modes Where RunForge Struggled

- Structured config-template signals are too indirect for the current keyword classifier.
- External provider/account blockers are not represented in the failure taxonomy.
- Deployment permission and process-gate failures fall into unsupported "other" territory.

## Recommendations

- Add taxonomy coverage for config-template, provider/account blocker, permission, and process-gate failures before claiming broader real-log coverage.
- Keep real-log metrics separate from fixture and placeholder metrics in every validation summary.
- Replace or augment deterministic scores with manual review for the 10 real cases before using this as product evidence.
