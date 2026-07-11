# selected-task-run Plan

Run ID: `selected-task-run`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `code-inspection`

## Accepted Task

Inspect task-run harness and identify the next non-provider implementation gap after executor dispatch

## Planning Basis

- Task asks for harness code inspection.
- Use CLI, harness, renderer, tests, and prior run artifacts as primary evidence.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `src/cli/commands/task-run.ts`
- `src/run/task-run-harness.ts`
- `src/run/task-run-renderer.ts`
- `tests/unit/task-run-renderer.test.ts`
- `package.json`
- `validation/runs/TASK-RUN-4`

## Decomposition

1. `01-cli-and-entrypoint-map`: Map how the task-run command accepts a task and writes run artifacts.
2. `02-planner-executor-gap`: Inspect planner, isolation, evidence, and aggregation behavior in harness code.
3. `03-test-and-artifact-gap`: Check whether tests and prior artifacts prove task-specific plans and evidence.

## Evidence Commands

- `01-cli-and-entrypoint-map`: `sed -n '1,220p' src/cli/commands/task-run.ts && rg -n "task-run" package.json`
- `02-planner-executor-gap`: `rg -n "subtasks|renderPlan|renderReport|runCheck|copyWorkspace|evidence|aggregation|recommended" src/run/task-run-harness.ts src/run/task-run-renderer.ts`
- `03-test-and-artifact-gap`: `sed -n '1,220p' tests/unit/task-run-renderer.test.ts && rg -n "taskKind|planningBasis|evidence|Remaining Gaps|subtasks" validation/runs/TASK-RUN-4/results.json`

## Executor

Each subtask evidence command is dispatched through `LocalShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-selected-task-run/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
