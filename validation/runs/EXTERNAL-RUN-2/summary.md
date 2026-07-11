# EXTERNAL-RUN-2 Summary

Final verdict: task-run completed with failed checks.

## Accepted Task

Run safe external repository triage

Task kind: `external-validation`

## Deterministic Facts

- Task kind: `external-validation`
- Plan artifact: `validation/runs/EXTERNAL-RUN-2/plan.md`
- Results artifact: `validation/runs/EXTERNAL-RUN-2/results.json`
- Subtask artifact root: `validation/runs/EXTERNAL-RUN-2/subtasks/`
- Executor lane: `docker-shell`
- Runtime mode: `docker` with image `runforge:local`
- Review lane: `deterministic-evidence-reviewer` using `providerless`
- Recommended next milestone: `broaden external task-run package-manager fixtures`
- External target: `/Users/evgeny/Documents/projects/factory`
- Original repo mutation verdict: `unchanged`
- RunForge capability classification: `passed`
- Target validation classification: `environment/setup issue`

## Delegated Review

- Review status: `blocked`
- Confidence: `low`
- Human decision required: yes
- Review request: `validation/runs/EXTERNAL-RUN-2/review/review-request.json`
- Review result: `validation/runs/EXTERNAL-RUN-2/review/review-result.json`
- Review markdown: `validation/runs/EXTERNAL-RUN-2/review/review.md`
- Provider review metadata: n/a (providerless default)

- info: Reviewed 3 subtask report(s), 3 command status record(s), and 3 owner check(s).
- error: 1 subtask evidence command(s) did not pass.
- warning: 1 owner check(s) failed.

## Owner Decision

The external target was validated through the first-class task-run planner, Docker executor, providerless review, and artifact aggregation path. The original repository is a read-only source; commands run only in disposable writable workspaces.

Recommended next milestone: broaden external task-run package-manager fixtures.

## Planning Basis

- An explicit external repository target was supplied.
- Validation runs in disposable writable workspaces through the opt-in Docker executor.
- The original repository is mounted read-only and checked before and after execution.

## Current Command

- `corepack pnpm dev task-run start --task "Run safe external repository triage" --out validation/runs/EXTERNAL-RUN-2 --repo /Users/evgeny/Documents/projects/factory --command "npm run typecheck" --command "npm test" --command "npm run build" --runtime docker --docker-image runforge:local`

## Artifacts Created

- `validation/runs/EXTERNAL-RUN-2/plan.md`
- `validation/runs/EXTERNAL-RUN-2/results.json`
- `validation/runs/EXTERNAL-RUN-2/summary.md`
- `validation/runs/EXTERNAL-RUN-2/review/review-request.json`
- `validation/runs/EXTERNAL-RUN-2/review/review-result.json`
- `validation/runs/EXTERNAL-RUN-2/review/review.md`

- `validation/runs/EXTERNAL-RUN-2/environment.json`
- `validation/runs/EXTERNAL-RUN-2/execution-log.md`
- `validation/runs/EXTERNAL-RUN-2/external-triage-report.md`
- `validation/runs/EXTERNAL-RUN-2/subtasks/`

## Isolation Method

Disposable tmp workspace snapshots were created under `/Users/evgeny/Documents/projects/RunForge-worktrees/.runforge-task-runs/factory-external-run-2`.

- `01-external-validation`: `/Users/evgeny/Documents/projects/RunForge-worktrees/.runforge-task-runs/factory-external-run-2/01-external-validation/workspace`
- `02-external-validation`: `/Users/evgeny/Documents/projects/RunForge-worktrees/.runforge-task-runs/factory-external-run-2/02-external-validation/workspace`
- `03-external-validation`: `/Users/evgeny/Documents/projects/RunForge-worktrees/.runforge-task-runs/factory-external-run-2/03-external-validation/workspace`

The original target was mounted read-only at `/source`; each disposable snapshot was writable at `/workspace`; networking was disabled; image `runforge:local` was used.

## Executor Dispatch

Subtasks were dispatched through `docker-shell`; planner output was converted into executor requests, and aggregation used executor results.

- `01-external-validation`: request `EXTERNAL-RUN-2:01-external-validation:docker-shell` -> passed; report `validation/runs/EXTERNAL-RUN-2/subtasks/01-external-validation/executor-report.json`
- `02-external-validation`: request `EXTERNAL-RUN-2:02-external-validation:docker-shell` -> failed; report `validation/runs/EXTERNAL-RUN-2/subtasks/02-external-validation/executor-report.json`
- `03-external-validation`: request `EXTERNAL-RUN-2:03-external-validation:docker-shell` -> passed; report `validation/runs/EXTERNAL-RUN-2/subtasks/03-external-validation/executor-report.json`

## Subtask Results

- `01-external-validation`: External target validation in a disposable Docker workspace. Evidence command passed with exit code 0. 01-external-validation inspected 3 input(s) and captured 8 stdout line(s). Sample: RUNFORGE_SOURCE_BEFORE_HEAD | d65ab9a9c8130f5d2c9214e8fdde2a278578afed | RUNFORGE_SOURCE_BEFORE_STATUS
- `02-external-validation`: External target validation in a disposable Docker workspace. Evidence command failed with exit code 1. 02-external-validation inspected 3 input(s) and captured 8 stdout line(s). Sample: RUNFORGE_SOURCE_BEFORE_HEAD | d65ab9a9c8130f5d2c9214e8fdde2a278578afed | RUNFORGE_SOURCE_BEFORE_STATUS
- `03-external-validation`: External target validation in a disposable Docker workspace. Evidence command passed with exit code 0. 03-external-validation inspected 3 input(s) and captured 8 stdout line(s). Sample: RUNFORGE_SOURCE_BEFORE_HEAD | d65ab9a9c8130f5d2c9214e8fdde2a278578afed | RUNFORGE_SOURCE_BEFORE_STATUS

## Checks

- `npm run typecheck`: passed
- `npm test`: failed
- `npm run build`: passed

## Evidence Captured

- `01-external-validation`: `npm run typecheck` -> passed; log `validation/runs/EXTERNAL-RUN-2/subtasks/01-external-validation/command.log`; executor report `validation/runs/EXTERNAL-RUN-2/subtasks/01-external-validation/executor-report.json`
- `02-external-validation`: `npm test` -> failed; log `validation/runs/EXTERNAL-RUN-2/subtasks/02-external-validation/command.log`; executor report `validation/runs/EXTERNAL-RUN-2/subtasks/02-external-validation/executor-report.json`
- `03-external-validation`: `npm run build` -> passed; log `validation/runs/EXTERNAL-RUN-2/subtasks/03-external-validation/command.log`; executor report `validation/runs/EXTERNAL-RUN-2/subtasks/03-external-validation/executor-report.json`

## Remaining Gaps

- Offline validation reuses an existing target node_modules snapshot when present; platform-specific optional packages may require a separately prepared Linux dependency cache.

## Recommended Next Milestone

Recommended next milestone: broaden external task-run package-manager fixtures.
