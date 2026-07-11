# RunForge Decisions

## AGENT-OS-ROADMAP-01

Date: 2026-07-10

Decision: RunForge / Factory is now framed as Agent OS / Task Factory, a portable task execution factory for routing meaningful tasks through intake, planning, decomposition, isolated execution, verification, aggregation, and human decision.

This replaces the previous "choose one of owner brief / CI triage / task loop" milestone framing. Owner briefs, CI triage, PR readiness, handoffs, packets, and archives remain useful only as parts of end-to-end task execution.

## Product Center

The product center is the execution loop:

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
-> apply / merge / send / continue
```

Internal machinery is valuable only when it moves a real task through this loop.

## Architecture Layers

- Task Intake: accept tasks and choose clarify / execute-as-is / plan-first.
- Planner / Decomposer: split large tasks into bounded subtasks.
- Runtime / Sandbox: run locally or on VPS in worktrees, containers, or disposable workspaces.
- Executor Agents: use CLI agents, models, shell tools, integrations, and external providers.
- Verification: run build, typecheck, tests, lint, CI, safety checks, and review.
- Aggregation / Compression: collect results, compress context, detect conflicts, and expose gaps.
- Owner Control: return evidence, a short report, and approve/reject/apply/merge/send/continue decisions.

## Artifact Model

Required product artifacts are:

- task intake record;
- plan;
- subtask briefs;
- executor logs;
- artifacts;
- verification report;
- aggregation summary;
- owner-ready report;
- decision log.

Packets, viewers, archives, handoffs, schemas, lifecycle reports, and setup policies are implementation capabilities. They are not product goals.

## Next Milestone Rule

Historical rule:

- `TASK-RUN-1: First End-to-End Agent OS Task`.

TASK-RUN-1 is now complete. The next milestone must be selected from validation evidence rather than a static roadmap line.

Current evidence through `TASK-RUN-6` supports `TASK-RUN-7: Evidence-aware docs/task-run planner refresh`.

Do not start Alpha-28, new archive/viewer work, new handoff/audit features, new OKF/skills lifecycle work, or new safety layers unless the selected task-run directly needs them.

## Governor Autonomy Decision

Date: 2026-07-11

Decision: the governor may continue autonomously for local providerless task-runs, evidence checks, documentation synchronization, and owner-ready reports.

Stop gates remain:

- secrets or provider configuration;
- push, merge, deploy, DB/prod access;
- Alpha-28;
- strategic product fork;
- standalone viewer/archive/handoff/OKF expansion.
