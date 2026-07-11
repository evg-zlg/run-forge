# 03-runtime-evidence-contract Brief

Goal: Verify runtime metadata is tested and rendered into owner-visible artifacts.

Workspace path: `/Users/evgeny/Documents/projects/.runforge-task-runs/runforge-task-run-7/03-runtime-evidence-contract/workspace`

Inputs to inspect:
- `src/run/task-run-renderer.ts`
- `tests/unit/task-run-executor.test.ts`
- `tests/unit/task-run-renderer.test.ts`

Evidence command:
```bash
rg -n "Runtime mode|containerUsed|docker-shell|dockerRunArgs|network.*none|runtime" src/run/task-run-renderer.ts tests/unit/task-run-executor.test.ts tests/unit/task-run-renderer.test.ts
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
