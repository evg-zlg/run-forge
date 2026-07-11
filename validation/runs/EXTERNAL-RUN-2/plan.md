# EXTERNAL-RUN-2 Plan

Run ID: `EXTERNAL-RUN-2`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `external-validation`

## Accepted Task

Run safe external repository triage

## Planning Basis

- An explicit external repository target was supplied.
- Validation runs in disposable writable workspaces through the opt-in Docker executor.
- The original repository is mounted read-only and checked before and after execution.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add scheduler, provider routing, daemon, provider catalog, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `package.json`
- `package-lock.json`
- `src`
- `tests`

## Decomposition

1. `01-external-validation`: Run external validation command: npm run typecheck
2. `02-external-validation`: Run external validation command: npm test
3. `03-external-validation`: Run external validation command: npm run build

## Evidence Commands

- `01-external-validation`: `npm run typecheck`
- `02-external-validation`: `npm test`
- `03-external-validation`: `npm run build`

## Executor

Each subtask evidence command is dispatched through `DockerShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

The original repository is mounted read-only at `/source`; each disposable snapshot is mounted writable at `/workspace` in a network-disabled container using `runforge:local`.

## Checks

```bash
npm run typecheck && npm test && npm run build
```
