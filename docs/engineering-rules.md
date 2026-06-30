# RunForge engineering rules

RunForge should obey the same discipline it asks of agentic engineering work: local, deterministic, inspectable, and honest about what was checked.

## Enforced today

1. Keep the MVP local and deterministic.
   - Checks must not require network services, hosted mode, SaaS infrastructure, BYOC setup, dashboards, billing, marketplaces, persona reviewers, auto-fix flows, workflow engines, or self-improvement overlays.
   - Enforced by `pnpm check:governance` scanning runtime source, scripts, and package metadata for scope creep terms.

2. Keep agent-readable source files small.
   - Source files under `src/**` target 250 lines, warn above 300, and fail above 350.
   - Enforced by `pnpm check:structure`.

3. Preserve the triage artifact contract.
   - A triage run writes `review.md`, `trajectory.json`, `safety-report.json`, and `context-summary.json`.
   - Enforced by integration tests and documented in `docs/report-contract.md`.

4. Keep validation provenance honest.
   - Each validation case must declare `source` as `real`, `fixture`, or `placeholder`.
   - Placeholder cases must explain why they are placeholders.
   - Validation summaries must report source groups separately so placeholder scores do not look like real coverage.
   - Enforced by `pnpm check:governance` and `pnpm validation:run`.

5. Dogfood RunForge locally.
   - `pnpm dogfood` runs governance, structure, typecheck, tests, build, validation, and the three fixture demos.
   - This is the default local command for checking RunForge against its own rules.

6. Keep agent git work isolated and inspectable.
   - One task gets one branch/worktree; non-trivial agent work does not happen directly on `main`.
   - Agents inspect branch, status, and base commit before work, stage explicit paths, avoid destructive git operations without approval, and report status, diff summary, checks, and commit hash at handoff.
   - Documented in `docs/git-worktree-rules.md` and checked lightly by `pnpm check:git-safety`.

## Rule backlog

Rules that matter but are not fully enforced yet should become one of:

- a CLI check;
- a unit or integration test;
- a report contract assertion;
- a validation metric;
- a CI step.

Until then, keep them documented here or in a focused scope document, with enough detail for a future check to be written.
