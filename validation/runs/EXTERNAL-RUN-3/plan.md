# EXTERNAL-RUN-3 Plan

Run ID: `EXTERNAL-RUN-3`
Date: 2026-07-11
Mode: task-specific repeatable harness
Task kind: `code-inspection`

## Accepted Task

Run full external repository validation readiness loop

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

1. `01-typecheck`: Run the target repository typecheck.
2. `02-test`: Run the target repository test suite through collection and execution.
3. `03-build`: Run the target repository production build.

## Evidence Commands

- `01-typecheck`: `npm run typecheck`
- `02-test`: `npm test`
- `03-build`: `npm run build`

## Executor

Each subtask evidence command is dispatched through `DockerShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

Each subtask snapshot is mounted read-only into a network-disabled container using the prebuilt local image `runforge:local`.

## Checks

```bash
corepack pnpm check:governance && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```
