# RunForge Non-Goals

RunForge must not become an internal DevOps artifact machine that keeps expanding viewers, archives, handoffs, and safety layers without proving end-to-end task execution.

## Current Freeze

- Alpha-28 trends.
- New viewer/dashboard/archive features.
- New handoff/audit features.
- New OKF/skills lifecycle features.
- New safety layers without direct connection to task execution.
- Internal artifact work that does not help a real task move from intake to verified result.
- Push, merge, deploy, DB/prod access, secrets, or provider configuration without owner approval.

## Not The Product Highway

- Setup/preflight policy by itself.
- Packet/evidence model by itself.
- Handoff packet by itself.
- Replay/audit by itself.
- Archive/search/viewer by itself.
- OKF/skills lifecycle by itself.
- Dashboards by themselves.

These are safety/evidence substrate for Agent OS. They are useful only when they help a task run, produce evidence, pass review, and return a decision point.

## Out Of Scope For The Current Roadmap

- SaaS hosting before the local/VPS task loop works.
- Generic remote compute platform.
- Generic queue system detached from task execution.
- Autonomous patch apply without owner control.
- Automatic PR merge.
- Automatic deployment.
- Provider marketplace.
- Multi-agent orchestration as a standalone feature.
- Dashboards that require the owner to inspect raw internals before seeing the task outcome.

## Product Boundary

If a feature cannot answer "how does this improve the local providerless task-run/governor loop from intake to evidence to owner decision?", it is outside the current roadmap.

## Historical Note

TASK-RUN-1 was the first end-to-end milestone and is complete. TASK-RUN-6 synchronized docs with validation evidence through TASK-RUN-5/GOVERNOR-1 and then completed. References to TASK-RUN-1 as the only next milestone are historical only; current next work must be selected from validation evidence.
