# AGENT-OS-2-DOCS Plan

Run ID: `AGENT-OS-2-DOCS`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `docs-review`

## Accepted Task

Review Agent OS roadmap docs and report contradictions, gaps, and next milestone.

## Planning Basis

- Task asks for roadmap documentation review.
- Use roadmap/current/non-goal/decision docs as primary evidence.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`

## Decomposition

1. `01-roadmap-source-map`: Map the Agent OS roadmap claims, current state, and frozen scope.
2. `02-contradiction-and-gap-scan`: Scan roadmap docs for contradictions, missing loop stages, and scope drift risks.
3. `03-next-milestone-readiness`: Identify the next milestone that best closes the documented roadmap gap.

## Evidence Commands

- `01-roadmap-source-map`: `rg -n "Agent OS|Task Factory|TASK-RUN|Next Milestone|Frozen|Alpha-28|Docker|isolated|owner" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md`
- `02-contradiction-and-gap-scan`: `rg -n "missing|gap|not yet|future|frozen|out of scope|not the product|drift|container|VPS|executor|aggregation|owner" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md docs/USE_CASES.md`
- `03-next-milestone-readiness`: `rg -n "Next Milestone|TASK-RUN|Remaining Gaps|Recommended Next Milestone|semantic planning|executor dispatch|aggregation|Docker" docs/ROADMAP.md docs/CURRENT_STATE.md validation/runs/TASK-RUN-4/summary.md`

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-agent-os-2-docs/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
