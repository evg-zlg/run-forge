# task-run-readiness Plan

Run ID: `task-run-readiness`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `general-review`

## Accepted Task

Assess current Agent OS branch merge readiness and identify blockers

## Planning Basis

- Task did not match docs or code heuristics exactly: Assess current Agent OS branch merge readiness and identify blockers
- Use repository overview plus current roadmap docs.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `README.md`
- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`

## Decomposition

1. `01-task-context-map`: Map the requested task against available repository context.
2. `02-gap-and-next-action`: Identify the smallest useful next action for the accepted task.

## Evidence Commands

- `01-task-context-map`: `rg -n "RunForge|Agent OS|task|harness|roadmap|current" README.md docs/ROADMAP.md docs/CURRENT_STATE.md`
- `02-gap-and-next-action`: `rg -n "Next Milestone|Missing|Frozen|Out Of Scope|gap|decision" docs/ROADMAP.md docs/NON_GOALS.md`

## Executor

Each subtask evidence command is dispatched through `LocalShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-task-run-readiness/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
