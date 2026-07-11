# 01-task-context-map Brief

Goal: Map the requested task against available repository context.

Workspace path: `/tmp/runforge-task-run-readiness/01-task-context-map/workspace`

Inputs to inspect:
- `README.md`
- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`

Evidence command:
```bash
rg -n "RunForge|Agent OS|task|harness|roadmap|current" README.md docs/ROADMAP.md docs/CURRENT_STATE.md
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
