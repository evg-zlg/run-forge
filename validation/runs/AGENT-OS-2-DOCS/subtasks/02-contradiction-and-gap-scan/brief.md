# 02-contradiction-and-gap-scan Brief

Goal: Scan roadmap docs for contradictions, missing loop stages, and scope drift risks.

Workspace path: `/tmp/runforge-agent-os-2-docs/02-contradiction-and-gap-scan/workspace`

Inputs to inspect:
- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`

Evidence command:
```bash
rg -n "missing|gap|not yet|future|frozen|out of scope|not the product|drift|container|VPS|executor|aggregation|owner" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md docs/USE_CASES.md
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
