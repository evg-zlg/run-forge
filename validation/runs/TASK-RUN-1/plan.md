# TASK-RUN-1 Plan

Run ID: `TASK-RUN-1`
Date: 2026-07-10
Mode: execute-as-is

## Accepted Task

Verify that the RunForge roadmap documents are mutually consistent, find contradictions, propose a minimal patch if needed, run checks, and produce an owner-ready report.

## Boundaries

- Do not start Alpha-28.
- Do not add viewer/archive/handoff/OKF lifecycle features.
- Do not do DB, production, secrets, deploy, push, or merge work.
- Do not invent a docs patch if the inspected docs are consistent.
- Focus only on proving the first end-to-end Agent OS task loop.

## Inputs

- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`
- `docs/CURRENT_STATE.md`
- `validation/runs/AGENT-OS-ROADMAP-01/summary.md`
- `validation/runs/AGENT-OS-ROADMAP-01/roadmap-review.json`

## Decomposition

1. `01-roadmap-loop`: verify the canonical north star, execution loop, system layers, supporting substrate, and next milestone are aligned across roadmap/current-state/decision/review artifacts.
2. `02-frozen-scope`: verify frozen scope and non-goals consistently block Alpha-28 and viewer/archive/handoff/OKF expansion before TASK-RUN-1.
3. `03-task-run-1-acceptance`: verify TASK-RUN-1 requirements and success criteria are aligned across roadmap/use-cases/current-state/previous summary.
4. `04-machine-consistency`: run a small machine-readable consistency scan over the required files for repeated canonical terms, milestone references, and forbidden milestone drift.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-task-run-1/<subtask>`.

Docker/container isolation was not used because this repository does not currently expose a ready TASK-RUN-1 container lane. This is recorded as an Agent OS harness gap.

## Expected Artifacts

- `validation/runs/TASK-RUN-1/summary.md`
- `validation/runs/TASK-RUN-1/results.json`
- `validation/runs/TASK-RUN-1/plan.md`
- `validation/runs/TASK-RUN-1/subtasks/`

Each subtask directory should contain a brief, command log or review log, copied result report, and any generated machine artifact.

## Checks

Minimum required check:

```bash
pnpm check:structure
```

Because only validation artifacts are expected to change unless a docs inconsistency is found, typecheck/test/build are not required unless code changes occur.
