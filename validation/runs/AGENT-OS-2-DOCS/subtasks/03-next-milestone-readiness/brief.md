# 03-next-milestone-readiness Brief

Goal: Identify the next milestone that best closes the documented roadmap gap.

Workspace path: `/tmp/runforge-agent-os-2-docs/03-next-milestone-readiness/workspace`

Inputs to inspect:
- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `validation/runs/TASK-RUN-4/summary.md`

Evidence command:
```bash
rg -n "Next Milestone|TASK-RUN|Remaining Gaps|Recommended Next Milestone|semantic planning|executor dispatch|aggregation|Docker" docs/ROADMAP.md docs/CURRENT_STATE.md validation/runs/TASK-RUN-4/summary.md
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
