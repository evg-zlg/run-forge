# GOVERNOR-1 Selected Task

Selected milestone: `TASK-RUN-5: Semantic task-specific planning`.

Selected task-run command:

```bash
corepack pnpm dev task-run start --task "Inspect task-run harness and identify the next non-provider implementation gap after executor dispatch" --out validation/runs/GOVERNOR-1/selected-task-run
```

## Why This Task

The roadmap and use cases still describe `TASK-RUN-1` as the next milestone, but recent validation artifacts show the project has already advanced through the first manual task run, repeatable harness, stale summary guard, executor dispatch, deterministic review, and an explicit CLI-provider-unavailable lane.

The strongest non-provider gap is now semantic task-specific planning:

- `TASK-RUN-4` explicitly recommended making plan/decomposition and subtask evidence derive from the accepted task instead of the static template.
- `AGENT-OS-PROVIDER-1-DEFAULT` proved local executor dispatch, evidence, review artifacts, and owner checks can pass providerless.
- `AGENT-OS-PROVIDER-1-REAL-OR-UNAVAILABLE` proved provider unavailability is clean and should not block governor work.
- The selected task-run itself completed, but its owner conclusion still drifted toward provider/delegated review despite the non-provider task. That is evidence that owner synthesis and planner semantics still need task binding.

## Explicit Non-Selection

Not selected:

- Alpha-28.
- New viewer/archive/handoff/OKF features.
- New provider/reviewer microsteps.
- Push, merge, deploy, or PR creation.
- Secrets, production, database, or provider configuration work.

## Expected Owner Value

The next implementation should make the task-run planner and owner conclusion choose task-specific lanes and next-step recommendations from the accepted task plus recent evidence, instead of falling back to stale roadmap/provider-oriented defaults.
