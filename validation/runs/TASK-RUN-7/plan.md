# TASK-RUN-7 Plan

Run ID: `TASK-RUN-7`
Date: 2026-07-10
Mode: task-specific repeatable harness
Task kind: `code-inspection`

## Accepted Task

Add an opt-in Docker-isolated task execution lane with offline read-only evidence commands and owner-visible runtime metadata

## Planning Basis

- Task asks for a concrete isolated runtime implementation.
- Use CLI wiring, executor policy, container build, tests, and owner-visible artifacts as primary evidence.

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add scheduler, provider routing, daemon, provider catalog, or dashboard work.
- Implement only enough to improve the task-run execution contour.

## Inputs

- `src/cli/commands/task-run.ts`
- `src/run/task-run-harness.ts`
- `src/run/task-run-executor.ts`
- `src/run/task-run-renderer.ts`
- `docker/Dockerfile`
- `tests/unit/task-run-executor.test.ts`

## Decomposition

1. `01-runtime-cli-and-dispatch`: Verify explicit local/Docker runtime selection reaches executor dispatch.
2. `02-container-safety-policy`: Verify the Docker lane is offline, read-only, bounded, and uses a prebuilt image.
3. `03-runtime-evidence-contract`: Verify runtime metadata is tested and rendered into owner-visible artifacts.

## Evidence Commands

- `01-runtime-cli-and-dispatch`: `rg -n "runtime|docker-image|DockerShellExecutor|LocalShellExecutor|executor.lane" src/cli/commands/task-run.ts src/run/task-run-harness.ts`
- `02-container-safety-policy`: `rg -n "pull|network|cap-drop|read-only|pids-limit|memory|cpus|tmpfs|readonly|removeContainer|FROM|ripgrep" src/run/task-run-executor.ts docker/Dockerfile`
- `03-runtime-evidence-contract`: `rg -n "Runtime mode|containerUsed|docker-shell|dockerRunArgs|network.*none|runtime" src/run/task-run-renderer.ts tests/unit/task-run-executor.test.ts tests/unit/task-run-renderer.test.ts`

## Executor

Each subtask evidence command is dispatched through `DockerShellExecutor` as an executor request. The executor writes `command.log`, `stdout.log`, `stderr.log`, and `executor-report.json` into the subtask artifact directory.

## Isolation

Each subtask snapshot is mounted read-only into a network-disabled container using the prebuilt local image `runforge:local`.

## Checks

```bash
corepack pnpm check:structure
```
