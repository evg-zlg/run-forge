# 01-cli-and-entrypoint-map Brief

Goal: Map how the task-run command accepts a task and writes run artifacts.

Workspace path: `/tmp/runforge-selected-task-run/01-cli-and-entrypoint-map/workspace`

Inputs to inspect:
- `src/cli/commands/task-run.ts`
- `package.json`

Evidence command:
```bash
sed -n '1,220p' src/cli/commands/task-run.ts && rg -n "task-run" package.json
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
