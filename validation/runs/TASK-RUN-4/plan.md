# TASK-RUN-4 Plan

Run ID: `TASK-RUN-4`
Date: 2026-07-10
Mode: guided repeatable harness

## Accepted Task

Inspect the task-run harness and add one narrow guard that prevents stale copied task wording in generated TASK-RUN summaries

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to repeat the TASK-RUN-1 task-run pattern.

## Inputs

- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`
- `docs/CURRENT_STATE.md`
- `validation/runs/AGENT-OS-ROADMAP-01/summary.md`
- `validation/runs/AGENT-OS-ROADMAP-01/roadmap-review.json`
- `validation/runs/TASK-RUN-1/summary.md`
- `validation/runs/TASK-RUN-1/results.json`

## Decomposition

1. `01-intake-and-plan`: Verify the harness accepts one task input and creates a concrete plan artifact.
2. `02-subtask-isolation`: Create one disposable tmp workspace snapshot per subtask, including untracked roadmap docs.
3. `03-roadmap-consistency-demo`: Repeat the roadmap consistency style from TASK-RUN-1 without proposing a source-doc patch.
4. `04-check-and-owner-summary`: Inspect summary rendering, run the configured check command, and aggregate owner-ready summary/results artifacts.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-task-run-4/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
