# RunForge Use Cases

## TASK-RUN-1: First End-to-End Agent OS Task

Status: completed as the first manual end-to-end roadmap task run.

Goal: prove the full task factory loop on one real task.

The system must:

- accept one meaningful task;
- clarify or execute as-is according to task intake mode;
- build a plan;
- decompose the work into 2-5 isolated subtasks;
- select appropriate models, tools, providers, or shell commands;
- execute subtasks in isolated environments;
- collect logs and artifacts;
- run checks and review;
- aggregate and compress results;
- return an owner-ready report with evidence and a decision point.

Minimum artifact: `owner-ready-report.md` or equivalent report that includes task, plan, subtask outcomes, execution locations, logs/artifacts, checks, unresolved gaps, and recommended decision.

Milestone result: one real task moved from intake to verified result without requiring the owner to inspect raw packet internals first.

## Current Task-Run Use Case

Goal: keep the local providerless governor loop aligned with actual validation evidence.

The system should:

- read roadmap/current/use-case/decision/non-goal docs;
- read recent task-run and governor validation artifacts;
- select or execute one bounded local providerless milestone;
- produce plan, subtask, check, review, summary, and results artifacts;
- update owner-facing docs when validation evidence makes roadmap language stale;
- stop for secrets, provider config, push/merge/deploy, DB/prod, Alpha-28, or a strategic fork.
- keep roadmap/current-state docs synchronized after completed validation runs.

Minimum artifact: a `validation/runs/TASK-RUN-*` or `validation/runs/GOVERNOR-*` package with plan, results, summary, subtasks, evidence, and owner-ready decision.

Milestone: the owner can give a high-level goal, and the governor can perform one local providerless roadmap loop with evidence and explicit stop gates.

Latest evidence: `TASK-RUN-6` completed documentation synchronization. The next useful use-case improvement is fresher evidence selection for docs/task-run planning so readiness checks do not lag behind recent validation runs.

## Supporting Use Cases

These use cases remain valid only as components of task-run/governor end-to-end runs.

## Task Intake

Goal: receive a task from a person or agent and choose clarify, execute-as-is, or plan-first.

Minimum artifact: task intake record with mode, assumptions, constraints, and acceptance criteria.

## Planning And Decomposition

Goal: turn a large task into bounded executor-ready subtasks.

Minimum artifact: plan plus 2-5 subtask briefs with inputs, outputs, environment needs, verification, and stop conditions.

## Isolated Execution

Goal: run subtasks locally or on VPS without contaminating the source workspace.

Minimum artifact: execution record with sandbox type, repo/worktree/container path, command log, and produced artifacts.

## Verification And Review

Goal: determine whether the task result is usable, blocked, unsafe, or incomplete.

Minimum artifact: verification report with build/typecheck/test/lint/CI/safety results and evidence links.

## Aggregation And Owner Control

Goal: compress subtask results into a human decision.

Minimum artifact: owner-ready report with approve/reject/apply/merge/send/continue recommendation.
