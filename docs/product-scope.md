# Product scope

## Current MVP

RunForge is currently a local, deterministic agentic engineering harness. It can run bounded task rails that produce reviewable artifacts instead of directly changing a repository.

The MVP includes:

- Local CLI commands for `doctor`, `init --safe`, `triage`, and `run`.
- Rails task types for `failure-triage`, `command-check`, `repo-research`, `context-pack`, and `code-proposal`.
- Context pack generation for selected repository files.
- Deterministic command evidence capture under explicit safety profiles.
- Gated `code-proposal` output that writes `proposal.patch` and `patch-summary.md`.
- Safety reports, trajectories, run records, and human review packets.
- The end-to-end `pnpm demo:mvp` packet at `artifacts/mvp-demo/sample-js-fix/`.

The MVP is useful for showing how a future agent run can be made inspectable: every important input, command, proposal, and safety decision is written as an artifact.

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
