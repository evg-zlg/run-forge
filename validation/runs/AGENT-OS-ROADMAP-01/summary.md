# AGENT-OS-ROADMAP-01 Summary

Final verdict: Agent OS / Task Factory roadmap fixed.

## What We Are Building

RunForge / Factory is an Agent OS: a portable task execution factory. It accepts a meaningful task from a person or another agent, clarifies or executes as-is, plans, decomposes, selects models/tools/providers, runs subtasks in isolated runtimes, gathers logs and artifacts, verifies the result, aggregates findings, and returns a human decision point.

## What Is Frozen

- Alpha-28 trends.
- New viewer/dashboard/archive features.
- New handoff/audit features.
- New OKF/skills lifecycle features.
- New safety layers without direct connection to task execution.
- Internal artifact work before the first end-to-end task run.

## System Layers

1. Task Intake.
2. Planner / Decomposer.
3. Runtime / Sandbox.
4. Executor Agents.
5. Verification.
6. Aggregation / Compression.
7. Owner Control.

## What Already Exists

- Setup/preflight.
- Packets/evidence.
- Failure triage and command checks.
- Proposal readiness.
- Proposal-only patch safety.
- Operator decision recording.
- Handoff.
- Audit/replay.
- Archive/search/viewer.
- OKF/skills lifecycle.

These are safety/evidence substrate for Agent OS, not the product highway.

## What TASK-RUN-1 Needs

- One real task.
- Task intake mode: clarify / execute-as-is / plan-first.
- Plan and 2-5 isolated subtasks.
- Runtime choice for each subtask.
- Executor assignment.
- Logs and artifacts.
- Checks and review.
- Aggregated owner-ready report.

## Success Criteria

- A real task moves from intake to verified result or honest blocker.
- Subtasks run in isolated environments.
- Logs and artifacts are captured.
- Checks are run and summarized.
- The final report is understandable without reading raw packet internals first.
- The owner receives a decision point: approve, reject, apply, merge, send, or continue.

## Updated Documents

- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`
- `docs/CURRENT_STATE.md`

