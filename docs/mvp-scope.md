# MVP scope

RunForge MVP only does local failure triage.

In scope:

- `doctor`, `init --safe`, and `triage` CLI commands.
- Log scanning and failure classification.
- Bounded read-only repository inspection.
- `review.md`, `trajectory.json`, `safety-report.json`, and `context-summary.json`.
- Deterministic mock provider.

Out of scope:

- SaaS.
- Web UI.
- Auto-fix.
- Auto-PR.
- Full workflow engine.
