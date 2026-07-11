# ROADMAP-LOCK-01 Summary

Final verdict: roadmap locked pending owner approval.

## Restored Goal

RunForge should serve the factory/forge loop where the owner gives a large task to ChatGPT, Factory/VPS executors, local or remote agents, and CI/PR reviewers, then receives evidence-backed owner artifacts for decision-making.

The restored loop is:

```text
task -> plan -> executor/session -> checks -> PR/CI -> evidence -> owner brief -> owner decision -> next step
```

## Current Drift

The Alpha line has produced useful infrastructure, but the center of gravity drifted toward setup policy, handoff lifecycle, replay/audit, archives, viewers, and OKF/skills work. These are useful only as support capabilities. They do not replace the owner's daily need to know what is ready, blocked, broken, risky, or waiting for a decision.

## What Already Exists

- Local deterministic failure triage.
- External command-check packets.
- Proposal readiness and code proposal packets.
- Setup/preflight policy.
- Packet validation, packet index, packet viewer, and dashboard seeds.
- Provider safety checks and forbidden-path rejection.
- Operator decision recording.
- Handoff packet, replay/audit, archive/search/viewer.
- Lifecycle and OKF/skills reports.

## Useful Bricks

- Failure triage and external command checks for `USE-2`.
- Packet/evidence model for all use cases.
- Proposal readiness and setup classification for PR readiness and CI triage.
- Operator decision recording for owner decision logs.
- Handoff/replay/archive for real task execution evidence.

## Frozen

- Alpha-28 trends.
- New viewer/dashboard layers.
- New archive features.
- New handoff features.
- New OKF/skills improvements.
- New safety layers without a real owner workflow.

## New Roadmap

Canonical documents were created:

- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/NON_GOALS.md`
- `docs/USE_CASES.md`
- `docs/CURRENT_STATE.md`

The next milestone must be one of:

- `USE-1: Owner Daily Brief`
- `USE-2: Real CI Failure Triage`
- `USE-3: Real Task Execution Loop`

Selection happens only after owner approval of `docs/ROADMAP.md`.

## First Three Use-Case Milestones

1. Owner Daily Brief: summarize one real active repo or branch into an owner-facing brief with blockers, readiness, CI/check state, evidence links, and owner decisions.
2. Real CI Failure Triage: classify one real CI/build failure as deterministic, flaky, setup, code, safety, or unknown, with evidence excerpts and safe next action.
3. Real Task Execution Loop: run one large task through breakdown, executor/session, evidence collection, verification, and owner-ready report.

## Benefit Criteria

- The owner can make a decision from one short artifact.
- The artifact links to evidence but does not require raw packet reading first.
- CI/build failures are classified without confusing setup failures with code failures.
- PR readiness exposes CI, branch freshness, unrelated changes, checks, and remaining risk.
- New infrastructure is accepted only when it improves an approved use case.

## Recommendation

Stop Alpha-28. Ask the owner to approve or edit `docs/ROADMAP.md`. After approval, choose exactly one next milestone from `USE-1`, `USE-2`, or `USE-3`; the strongest first pick is `USE-1: Owner Daily Brief` because it turns existing evidence into immediate daily value.

