# 01-roadmap-source-map Brief

Goal: Map the Agent OS roadmap claims, current state, and frozen scope.

Workspace path: `/tmp/runforge-agent-os-2-docs/01-roadmap-source-map/workspace`

Inputs to inspect:
- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`

Evidence command:
```bash
rg -n "Agent OS|Task Factory|TASK-RUN|Next Milestone|Frozen|Alpha-28|Docker|isolated|owner" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
