# TASK-RUN-5 Plan

Run ID: `TASK-RUN-5`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `code-inspection`

## Accepted Task

Inspect task-run harness and identify the next non-provider implementation gap after executor dispatch

## Planning Basis

- Task asks for a non-provider harness implementation gap after executor dispatch.
- Recent governor evidence identified owner-conclusion drift toward provider work for non-provider tasks.
- Use planner, owner-decision, renderer, tests, and GOVERNOR-1 artifacts as primary evidence.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `src/run/task-run-planner.ts`
- `src/run/task-run-owner-decision.ts`
- `src/run/task-run-renderer.ts`
- `tests/unit/task-run-renderer.test.ts`
- `validation/runs/GOVERNOR-1/results.json`
- `validation/runs/GOVERNOR-1/summary.md`

## Decomposition

1. `01-planner-task-binding`: Verify planner classification and recommended milestone bind to semantic task-specific planning / owner-decision binding.
2. `02-owner-decision-binding`: Verify owner decision text recommends semantic task-specific planning / owner-decision binding without provider drift.
3. `03-artifact-consistency-check`: Confirm plan, summary, review, and results artifacts expose semantic task-specific planning / owner-decision binding.

## Evidence Commands

- `01-planner-task-binding`: `rg -n "semantic task-specific planning|owner-decision|non-provider|recommendedNextMilestone|codePlan|planTaskRun" src/run/task-run-planner.ts validation/runs/GOVERNOR-1/results.json`
- `02-owner-decision-binding`: `rg -n "semantic task-specific planning|owner-decision binding|non-provider|provider|delegated" src/run/task-run-owner-decision.ts tests/unit/task-run-renderer.test.ts`
- `03-artifact-consistency-check`: `rg -n "selectedMilestone|recommendedNextMilestone|Recommended Next Milestone|Selected Milestone|review" src/run/task-run-renderer.ts src/run/task-run-reviewer.ts`

## Executor

Each subtask evidence command is dispatched through `LocalShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-task-run-5/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
