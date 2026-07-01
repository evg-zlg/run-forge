# Safety model

RunForge's MVP safety model is artifact-first and human-gated. The harness may inspect local files, run allowed commands under an explicit profile, and write artifacts to the requested output directory, but it does not silently change the target repository.

## Proposal-only patch

`code-proposal` is gated. In the MVP demo it writes a unified diff to `proposal/proposal.patch` and a readable summary to `proposal/patch-summary.md`.

The patch is an artifact, not an applied change. RunForge can validate that the patch would apply with `git apply --check`, but validation is still not mutation.

## No repo mutation

The MVP demo snapshots the fixture files before and after the run and fails if they changed. RunForge writes the demo packet under `artifacts/mvp-demo/sample-js-fix/` and leaves `fixtures/repos/sample-js` unchanged.

The root worktree status is captured in `human-review.md` so reviewers can see whether the surrounding repository was clean or already had unrelated changes.

## Human decision required

RunForge stops at the review packet. A human reads the context, command evidence, proposal patch, patch summary, safety report, and trajectory, then decides whether to apply the patch manually outside RunForge.

There is no automatic apply, auto-PR, or auto-merge in the MVP.

## No LLM/API yet

The MVP demo is local and deterministic. It does not call an LLM or external API. The current proposal behavior for the sample fixture is deterministic and fixture-based.

## Command and file safety boundaries

RunForge records safety policy decisions in run artifacts and uses explicit safety profiles for task execution.

For the MVP:

- Triage is read-only against the target repository.
- Context packing reads bounded file sets selected by include/exclude rules and size limits.
- Command checks run explicit commands under an explicit safety profile and capture output as evidence.
- Proposal generation writes patch artifacts, not repository changes.
- Artifacts are written to the requested output directory.
- Secret-like values in logs and reports are scanned before output.

The Docker safe profile adds stronger process and environment isolation for supported workflows. See `docker/README.md` and `docs/security-model.md`.

## Artifact-based review

The review boundary is the artifact packet. For the MVP demo, the key artifacts are:

- `task.md`
- `human-review.md`
- `context/context-pack.md`
- `context/context-pack.json`
- `checks/command-output.txt`
- `checks/command-result.json`
- `proposal/proposal.patch`
- `proposal/patch-summary.md`
- `safety-report.json`
- `trajectory.json`

These files make the run inspectable without trusting hidden agent state.
