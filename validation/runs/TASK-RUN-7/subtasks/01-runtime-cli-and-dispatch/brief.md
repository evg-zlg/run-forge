# 01-runtime-cli-and-dispatch Brief

Goal: Verify explicit local/Docker runtime selection reaches executor dispatch.

Workspace path: `/Users/evgeny/Documents/projects/.runforge-task-runs/runforge-task-run-7/01-runtime-cli-and-dispatch/workspace`

Inputs to inspect:
- `src/cli/commands/task-run.ts`
- `src/run/task-run-harness.ts`

Evidence command:
```bash
rg -n "runtime|docker-image|DockerShellExecutor|LocalShellExecutor|executor.lane" src/cli/commands/task-run.ts src/run/task-run-harness.ts
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
