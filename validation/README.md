# RunForge validation harness

Add sanitized failure logs or case folders under `validation/cases/`.

For each case:

1. Add the log and any minimal repo fixture needed for bounded inspection.
2. Run `runforge triage --repo <repo> --log <log> --out validation/runs/<case-id>`.
3. Score the resulting `review.md` using `validation/score-template.json`.

## Rubric

- Root cause: 0-3
- Evidence: 0-3
- Safe next command: 0-3
- Honesty/checked-not-checked: 0-3
- Security: pass/fail

Prefer notes that explain why points were lost. The goal is a useful triage report, not model theater.
