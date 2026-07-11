# 02-owner-decision-binding Brief

Goal: Verify owner decision text recommends semantic task-specific planning / owner-decision binding without provider drift.

Workspace path: `/tmp/runforge-task-run-5/02-owner-decision-binding/workspace`

Inputs to inspect:
- `src/run/task-run-owner-decision.ts`
- `tests/unit/task-run-renderer.test.ts`

Evidence command:
```bash
rg -n "semantic task-specific planning|owner-decision binding|non-provider|provider|delegated" src/run/task-run-owner-decision.ts tests/unit/task-run-renderer.test.ts
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
