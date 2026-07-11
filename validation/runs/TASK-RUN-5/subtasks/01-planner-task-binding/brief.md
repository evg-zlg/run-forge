# 01-planner-task-binding Brief

Goal: Verify planner classification and recommended milestone bind to semantic task-specific planning / owner-decision binding.

Workspace path: `/tmp/runforge-task-run-5/01-planner-task-binding/workspace`

Inputs to inspect:
- `src/run/task-run-planner.ts`
- `validation/runs/GOVERNOR-1/results.json`

Evidence command:
```bash
rg -n "semantic task-specific planning|owner-decision|non-provider|recommendedNextMilestone|codePlan|planTaskRun" src/run/task-run-planner.ts validation/runs/GOVERNOR-1/results.json
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
