# 02-container-safety-policy Brief

Goal: Verify the Docker lane is offline, read-only, bounded, and uses a prebuilt image.

Workspace path: `/Users/evgeny/Documents/projects/.runforge-task-runs/runforge-task-run-7/02-container-safety-policy/workspace`

Inputs to inspect:
- `src/run/task-run-executor.ts`
- `docker/Dockerfile`

Evidence command:
```bash
rg -n "pull|network|cap-drop|read-only|pids-limit|memory|cpus|tmpfs|readonly|removeContainer|FROM|ripgrep" src/run/task-run-executor.ts docker/Dockerfile
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
