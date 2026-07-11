# EXTERNAL-RUN-3 Plan

Run ID: `EXTERNAL-RUN-3`
Date: 2026-07-11
Mode: task-specific repeatable harness
Task kind: `code-inspection`

## Accepted Task

Run full external repository validation readiness loop after safety fix

## Planning Basis

- Task targets an explicitly declared external JavaScript/TypeScript repository.
- Validation commands run sequentially in a prepared disposable Linux workspace with runtime network disabled.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add scheduler, provider routing, daemon, provider catalog, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src`
- `tests`

## Decomposition

1. `01-external-validation`: Run external validation command 1.
2. `02-external-validation`: Run external validation command 2.
3. `03-external-validation`: Run external validation command 3.

## Evidence Commands

- `01-external-validation`: `npm run typecheck`
- `02-external-validation`: `npm test`
- `03-external-validation`: `npm run build`

## Executor

Each subtask evidence command is dispatched through `DockerShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

The original repository is not mounted. A prepared disposable workspace is mounted writable into network-disabled containers using `runforge:local`.

## Checks

```bash
corepack pnpm check:structure && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```
