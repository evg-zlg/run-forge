# Agent OS / Task Factory Roadmap

Status: active north star.

RunForge / Factory is an Agent OS: a portable task execution factory.

It lets a person or another agent submit a meaningful task, then routes it through a controlled execution loop:

```text
task
-> clarification or execute-as-is
-> plan
-> decomposition
-> model/tool/provider selection
-> isolated sandbox/runtime execution
-> logs and artifacts
-> checks and review
-> human decision
-> apply / merge / send / continue.
```

The product is not the internal artifact machinery. The product is reliable end-to-end task execution with enough isolation, evidence, verification, and owner control that a human can safely decide what happens next.

## Audience

The first user is an owner/operator who delegates real work across codebases, models, agents, tools, local machines, and VPS executors.

Secondary users are other agents that need to submit tasks into the factory and receive structured outcomes instead of vague chat summaries.

## System Layers

1. Task Intake
   Accept a task and select the mode: clarify, execute-as-is, or plan-first.

2. Planner / Decomposer
   Break large tasks into small isolated subtasks with clear inputs, outputs, constraints, and verification.

3. Runtime / Sandbox
   Execute locally or on VPS in a worktree, Docker/container, disposable workspace, or other bounded runtime.

4. Executor Agents
   Run CLI agents, models, shell tools, integrations, and external providers against scoped subtasks.

5. Verification
   Run build, typecheck, tests, lint, CI, safety checks, and task-specific review.

6. Aggregation / Compression
   Collect results, compress context, detect conflicts, expose missing evidence, and identify gaps between subtasks.

7. Owner Control
   Return a short report, evidence, and a decision point: approve, reject, apply, merge, send, or continue.

## First Practical Value

The first practical value is one real end-to-end task run: the system accepts a meaningful task, plans it, decomposes it into 2-5 isolated subtasks, runs them in controlled environments, gathers artifacts, verifies the result, and returns an owner-ready report.

## Completed Task-Run Evidence

Validation evidence now shows the first practical value has moved from target to working local loop:

- `TASK-RUN-1`: completed the first manual end-to-end roadmap task run.
- `TASK-RUN-2`: completed the repeatable task-run harness.
- `TASK-RUN-3`: completed a gap review and exposed static planning/owner-summary limits.
- `TASK-RUN-4`: completed stale-summary/current-command guard work.
- `GOVERNOR-1`: completed the first self-driving roadmap loop and selected the next task-run without per-step owner approval.
- `TASK-RUN-5`: completed semantic task-specific planning / owner-decision binding for the non-provider implementation gap.
- `TASK-RUN-6`: completed roadmap/current-state synchronization from validation evidence.

The loop is still local and providerless by default. It uses disposable workspace snapshots, local shell executor dispatch, deterministic evidence review, and owner-ready artifacts. Docker/container isolation, remote/VPS execution, provider-backed reviewers, and push/merge/deploy remain outside the default autonomous lane.

## Current Milestone

The current milestone is `TASK-RUN-7: Evidence-aware docs/task-run planner refresh`.

TASK-RUN-6 synchronized docs with validation evidence and removed stale TASK-RUN-1-only framing. TASK-RUN-7 should close the next evidence-backed gap found during TASK-RUN-6: docs-review planning still used an older TASK-RUN-4 evidence query even though current evidence reaches TASK-RUN-6.

`TASK-RUN-7` must:

- make docs/task-run planning choose recent validation evidence dynamically enough to avoid stale TASK-RUN-4-only readiness checks;
- keep the default providerless/offline;
- avoid new viewer/archive/handoff/OKF work and other platform expansion;
- preserve stop gates for secrets, provider config, push/merge/deploy, DB/prod, Alpha-28, and strategic forks.

The next milestone after TASK-RUN-7 should again be selected from validation evidence, not from a static roadmap line.

## Supporting Substrate

Alpha-19 through Alpha-27 produced useful supporting layers:

- setup/preflight;
- packets/evidence;
- handoff;
- audit/replay;
- archive/search/viewer;
- OKF/skills lifecycle.

These are not the product highway. They are the safety/evidence substrate for Agent OS and should be used only when they help complete end-to-end task execution.

## Current Freeze

- Alpha-28 trends.
- New viewer/dashboard/archive features.
- New handoff/audit features.
- New OKF/skills lifecycle features.
- New safety layers without direct connection to task execution.
- Provider/reviewer expansion unless explicitly configured and directly required by a selected task-run.
- Push, merge, deploy, DB/prod access, or secrets without owner approval.

## Drift Guard

Before every new task, answer:

1. Which end-to-end workflow does this improve?
2. Which user pain does it close?
3. Which externally useful artifact will appear?
4. Can it be used tomorrow?
5. What will we not do in this task?

If these answers are missing or weak, do not start the task.

## Drift Signals

The project is drifting when the main output is a new internal viewer, archive, schema, handoff shape, safety layer, or lifecycle report that does not help a task move from intake to verified result to human decision.

The project is on course when a real task can enter the factory, be decomposed, run in isolated execution contexts, produce evidence, pass or fail checks honestly, and return a short owner-ready decision report.

## Governor Autonomy

The governor may continue autonomously for local providerless task-runs, evidence checks, documentation synchronization, and owner-ready reports. It must stop for owner approval before secrets, provider configuration, push/merge/deploy, DB/prod access, Alpha-28, or a strategic product fork.
