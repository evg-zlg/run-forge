# Run Rails

RunForge local rails route every task through:

```text
Run -> Task -> SafetyPolicy -> Context -> Execution -> Artifacts -> Trajectory -> Report -> Human decision
```

## Task Types

- `failure-triage`: wraps the existing deterministic failure triage runner.
- `command-check`: runs one local command only under `trusted-local`.
- `repo-research`: inspects package metadata, lockfiles, and guidance files.
- `context-pack`: builds a compact context artifact from repo metadata plus optional log input.
- `code-proposal`: creates gated proposal artifacts without writing to the target repo.

## Common Artifacts

Each `runforge run` invocation writes a timestamped run directory under `RunSpec.outDir`:

```text
run.json
review.md
trajectory.json
safety-report.json
context-summary.json
```

Task implementations may add task-specific artifacts beside those files.

## Code Proposal Gate

`code-proposal` is proposal-first:

- no direct writes to the target repository;
- no auto-push;
- no auto-merge;
- patch artifacts only;
- human decision required before applying any patch.

The local rails implementation is currently deterministic and fixture-based, not an LLM coder. For the controlled `fixtures/repos/sample-js` calculator assertion task, it can emit a real unified diff in `proposal.patch`; for repositories without a matching deterministic rule, `proposal.patch` may still be empty.

Inspect `patch-summary.md` first for the task summary, proposed files, rationale, safety status, and manual next step. Then inspect `proposal.patch` as a reviewable artifact. RunForge does not apply the patch, does not mutate the target repository, does not push, and does not merge.

If a human accepts the proposal, they can apply it manually outside RunForge, for example:

```sh
git apply path/to/proposal.patch
```

That manual apply step is intentionally outside the RunForge run boundary.

## Rails Dogfood

`pnpm dogfood:rails` exercises RunForge's own checks through `runforge run --task command-check`. Artifacts are written under:

```text
artifacts/runs/dogfood-rails/
```

Inspect a check by opening its newest run directory and reading `run.json` for status, `review.md` for the human-facing summary, `trajectory.json` for stage evidence, `safety-report.json` for policy decisions, `context-summary.json` for inputs and artifact paths, and `command-result.json` / `command-output.txt` for the command result.
