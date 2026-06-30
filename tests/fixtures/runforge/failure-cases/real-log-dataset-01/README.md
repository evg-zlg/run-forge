# RUNFORGE-REAL-LOG-DATASET-01

Ten real sanitized failure cases prepared for RunForge validation.

## Distribution

| Class | Count | Cases |
| --- | ---: | --- |
| Test failures | 3 | RF-REAL-001, RF-REAL-002, RF-REAL-003 |
| Typecheck/build failures | 2 | RF-REAL-004, RF-REAL-005 |
| Env/config/dependency failures | 2 | RF-REAL-006, RF-REAL-007 |
| Infra/timeout failure | 1 | RF-REAL-008 |
| Other real failures | 2 | RF-REAL-009, RF-REAL-010 |

## Source Mix

- SmartSQL GitHub/CI reports: RF-REAL-001, RF-REAL-002, RF-REAL-006, RF-REAL-008, RF-REAL-009, RF-REAL-010.
- SmartSQL local reports from prior failed checks: RF-REAL-003, RF-REAL-004.
- Buildkite migration/failure context: RF-REAL-007 records the real GitHub Actions billing block that forced Buildkite primary delivery lanes.
- Historical artifact reports: all cases point to committed `reports/` or `docs/dev-workspace/task-briefs/` sources.

## Sanitization Rules Applied

- No raw tokens, private keys, `.env` values, DB URLs, or secret-bearing logs.
- No full raw logs; each case keeps bounded excerpts only.
- Customer or tenant payloads are excluded; identifiers kept only when they are public issue/run IDs or repo file paths.
- Host/user permission class is described without copying private SSH material.

## Notes For RunForge Validation

Each JSON case includes:

- `class`: the target high-level failure class.
- `observedFailure`: the compact signal RunForge should classify.
- `expectedRunForgeClassification`: expected primary class, secondary tags, retryability, and likely owner.
- `sourcePath`: repo-local evidence pointer for traceability.

Direct saved Buildkite failed log excerpts were not present in this worktree. The dataset therefore uses the available Buildkite migration evidence for RF-REAL-007 and avoids inventing Buildkite-only failures.
