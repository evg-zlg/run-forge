# 02-planner-executor-gap Brief

Goal: Inspect planner, isolation, evidence, and aggregation behavior in harness code.

Workspace path: `/tmp/runforge-agent-os-2-code/02-planner-executor-gap/workspace`

Inputs to inspect:
- `src/run/task-run-harness.ts`
- `src/run/task-run-renderer.ts`

Evidence command:
```bash
rg -n "subtasks|renderPlan|renderReport|runCheck|copyWorkspace|evidence|aggregation|recommended" src/run/task-run-harness.ts src/run/task-run-renderer.ts
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
