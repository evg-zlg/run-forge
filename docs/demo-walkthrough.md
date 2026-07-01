# Demo walkthrough

Run the current MVP demo from the repository root:

```bash
pnpm install
pnpm demo:mvp
```

The demo writes a complete review packet to:

```text
artifacts/mvp-demo/sample-js-fix/
```

The packet demonstrates a tiny `sample-js` calculator test fix. RunForge collects context, records deterministic check evidence, creates a gated proposal-only patch, validates that the patch can apply, and writes a human review packet without mutating the fixture repository.

## What to inspect first

Start with `human-review.md`. It is the reviewer entry point and explains what task was attempted, which context was collected, which checks were used, which patch is proposed, why the packet is safe, whether the repo changed, and what a human should do next.

Then inspect `task.md`, `proposal/proposal.patch`, `proposal/patch-summary.md`, `safety-report.json`, and `trajectory.json`.

## Packet files

### `task.md`

The task statement for the demo. It explains the intended tiny fixture fix: `add(1, 1)` returns `2`, while the fixture test expects `3`, so the proposed change is to update the expectation to `2`.

### `human-review.md`

The human-facing review packet. It summarizes the task, context, evidence, patch proposal, safety guarantees, fixture cleanliness result, root worktree status captured by the demo, and the next human decision.

### `context/`

The copied context pack from the `context-pack` child run.

- `context/context-pack.md` is the readable context summary.
- `context/context-pack.json` is the structured context artifact.

For the MVP demo, the context pack includes the fixture `package.json`, calculator implementation, and calculator test.

### Command and evidence artifacts

The `checks/` directory contains deterministic command evidence from the `command-check` child run.

- `checks/command-output.txt` captures the command output.
- `checks/command-result.json` captures the structured command result.

The command intentionally records the expectation mismatch: `Expected add(1, 1) to be 3, received 2`.

### `proposal/proposal.patch`

The proposal-only unified diff from the `code-proposal` child run. The MVP does not apply this patch. It writes the patch as an artifact so a human can inspect it and decide whether to apply it manually outside RunForge.

The demo also validates the proposal with `git apply --check` against the fixture repository.

### `proposal/patch-summary.md`

The readable patch summary. It explains what the proposal changes and repeats that a human decision is required before any apply step.

### `safety-report.json`

The packet-level safety report. It records that the demo is local-only, makes no provider calls, does not allow repo mutation, does not create PRs, does not merge, uses proposal-only patch mode, requires a human decision, and confirms the fixture repository stayed unchanged.

### `trajectory.json`

The end-to-end demo trajectory. It records the stages RunForge executed, child run summaries, and validation results such as `proposalPatchAcceptedByGitApplyCheck` and `fixtureRepoUnchanged`.

### `_runs/` and `child-runs.json`

The `_runs/` directory contains the raw child run output for the context pack, command check, and code proposal stages. `child-runs.json` summarizes those child runs and points to their original artifacts.
