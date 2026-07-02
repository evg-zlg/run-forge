# Product scope

## Current alpha

RunForge is currently a local, deterministic agentic engineering harness. It can run bounded task rails that produce reviewable artifacts instead of directly changing a repository.

The current alpha includes:

- Local CLI commands for `doctor`, `init --safe`, `triage`, `run`, and
  `external docs-proposal`.
- Rails task types for `failure-triage`, `command-check`, `repo-research`, `context-pack`, and `code-proposal`.
- Context pack generation for selected repository files.
- Deterministic command evidence capture under explicit safety profiles.
- Gated `code-proposal` output that writes `proposal.patch` and `patch-summary.md`.
- A validated external docs proposal wedge that writes complete proposal packets, checks patch applicability, leaves external repositories unmodified, and can be run from flags without hand-writing RunSpec JSON.
- Safety reports, trajectories, run records, and human review packets.
- The end-to-end `pnpm demo:mvp` packet at `artifacts/mvp-demo/sample-js-fix/`.

The alpha is useful for showing how a future agent run can be made inspectable: every important input, command, proposal, and safety decision is written as an artifact. The validated product wedge is external docs proposal, not generic autonomous engineering. The CLI wedge removes the need to hand-write RunSpec JSON for that validated case while preserving read-only external repo behavior.

See [alpha-snapshot-2026-07-02.md](alpha-snapshot-2026-07-02.md) for the current external validation summary.

## Explicitly not included yet

RunForge does not currently include:

- SaaS hosting.
- Dashboard or web UI.
- Remote compute.
- Queues or distributed workers.
- Provider orchestration.
- LLM/API calls in the MVP demo.
- Automatic repository mutation.
- Automatic patch apply.
- Automatic pull request creation.
- Automatic merge.
- Autonomous delivery without a human decision.
- Validated arbitrary code changes against external repositories.
- Generic LLM proposal generation.
- CI triage outside the checked-in fixtures.
- Remote or hosted execution.

The current `openai-compatible` provider code is only a skeleton and is not required for tests or the MVP demo.

## Future directions

Future work may expand RunForge into a richer engineering harness while keeping the artifact-first safety model:

- Broader task rails for more engineering workflows.
- Stronger context selection and review packet ergonomics.
- More validation and scoring against real failure cases.
- Better policy controls for commands, files, and apply modes.
- Optional provider integrations behind explicit safety gates.
- Review workflows that preserve human approval before repository mutation.

These directions are not part of the current MVP contract.
