# 02-gap-and-next-action Brief

Goal: Identify the smallest useful next action for the accepted task.

Workspace path: `/tmp/runforge-task-run-readiness/02-gap-and-next-action/workspace`

Inputs to inspect:
- `docs/ROADMAP.md`
- `docs/NON_GOALS.md`

Evidence command:
```bash
rg -n "Next Milestone|Missing|Frozen|Out Of Scope|gap|decision" docs/ROADMAP.md docs/NON_GOALS.md
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
