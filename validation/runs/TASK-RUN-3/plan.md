# TASK-RUN-3 Plan

Run ID: `TASK-RUN-3`
Date: 2026-07-10
Mode: guided repeatable harness

## Accepted Task

Review TASK-RUN-1 and TASK-RUN-2 artifacts for Agent OS loop gaps

## Boundaries

- Do not start Alpha-28.
- Do not add archive/viewer/handoff/OKF features.
- Do not add Docker, scheduler, provider routing, daemon, marketplace, or dashboard work.
- Implement only enough to repeat the TASK-RUN-1 task-run pattern.

## Inputs

- `docs/ROADMAP.md`
- `docs/CURRENT_STATE.md`
- `docs/USE_CASES.md`
- `validation/runs/AGENT-OS-ROADMAP-01/summary.md`
- `validation/runs/AGENT-OS-ROADMAP-01/roadmap-review.json`
- `validation/runs/TASK-RUN-1/plan.md`
- `validation/runs/TASK-RUN-1/summary.md`
- `validation/runs/TASK-RUN-1/results.json`
- `validation/runs/TASK-RUN-2/plan.md`
- `validation/runs/TASK-RUN-2/summary.md`
- `validation/runs/TASK-RUN-2/results.json`

## Decomposition

1. `01-intake-and-plan`: Compare TASK-RUN-1 manual loop and TASK-RUN-2 harness intake/plan artifacts.
2. `02-subtask-isolation`: Verify what isolation was real and what remained future work.
3. `03-loop-gap-review`: Identify real vs simulated Agent OS loop steps.
4. `04-check-and-owner-summary`: Run the configured check command and aggregate the owner-ready gap report.

## Isolation

Each subtask uses a disposable tmp workspace snapshot under `/tmp/runforge-task-run-3/<subtask>/workspace`.

Docker/container isolation is a future gap and is not implemented in this run.

## Checks

```bash
corepack pnpm check:structure
```
