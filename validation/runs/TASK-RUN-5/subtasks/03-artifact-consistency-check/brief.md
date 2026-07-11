# 03-artifact-consistency-check Brief

Goal: Confirm plan, summary, review, and results artifacts expose semantic task-specific planning / owner-decision binding.

Workspace path: `/tmp/runforge-task-run-5/03-artifact-consistency-check/workspace`

Inputs to inspect:
- `src/run/task-run-renderer.ts`
- `src/run/task-run-reviewer.ts`

Evidence command:
```bash
rg -n "selectedMilestone|recommendedNextMilestone|Recommended Next Milestone|Selected Milestone|review" src/run/task-run-renderer.ts src/run/task-run-reviewer.ts
```

Required output: `report.md` with status, findings, command evidence, and artifacts.
