# 03-test-and-artifact-gap Brief

Goal: Check whether tests and prior artifacts prove task-specific plans and evidence.

Workspace path: `/tmp/runforge-selected-task-run/03-test-and-artifact-gap/workspace`

Inputs to inspect:
- `tests/unit/task-run-renderer.test.ts`
- `validation/runs/TASK-RUN-4/results.json`

Evidence command:
```bash
sed -n '1,220p' tests/unit/task-run-renderer.test.ts && rg -n "taskKind|planningBasis|evidence|Remaining Gaps|subtasks" validation/runs/TASK-RUN-4/results.json
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
