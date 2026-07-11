# 02-gap-and-next-action Report

Subtask id: `02-gap-and-next-action`

Goal: Identify the smallest useful next action for the accepted task.

Workspace path: `/tmp/runforge-task-run-readiness/02-gap-and-next-action/workspace`

Inputs inspected:
- `docs/ROADMAP.md`
- `docs/NON_GOALS.md`

Findings:
- Gaps, constraints, and next action candidates. Evidence command passed with exit code 0.
- 02-gap-and-next-action inspected 2 input(s) and captured 11 stdout line(s). Sample: docs/ROADMAP.md:18:-> human decision | docs/ROADMAP.md:48:   Collect results, compress context, detect conflicts, expose missing evidence, and identify gaps between subtasks. | docs/ROADMAP.md:51:   Return a short report, evidence, and a decision point: approve, reject, apply, merge, send, or continue.

Evidence:
- Command: `rg -n "Next Milestone|Missing|Frozen|Out Of Scope|gap|decision" docs/ROADMAP.md docs/NON_GOALS.md`
- Status: passed
- Exit code: 0
- Log: `validation/runs/AGENT-OS-DOGFOOD-1/task-run-readiness/subtasks/02-gap-and-next-action/command.log`
- Executor: local-shell
- Executor request: `task-run-readiness:02-gap-and-next-action:local-shell`
- Executor report: `validation/runs/AGENT-OS-DOGFOOD-1/task-run-readiness/subtasks/02-gap-and-next-action/executor-report.json`
- Stdout log: `validation/runs/AGENT-OS-DOGFOOD-1/task-run-readiness/subtasks/02-gap-and-next-action/stdout.log`
- Stderr log: `validation/runs/AGENT-OS-DOGFOOD-1/task-run-readiness/subtasks/02-gap-and-next-action/stderr.log`

Status: done

Artifacts:
- `brief.md`
- `report.md`
- `command.log`
- `stdout.log`
- `stderr.log`
- `executor-report.json`
