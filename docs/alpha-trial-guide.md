# RunForge Alpha Trial Guide

This guide is for a first local alpha trial against another repository. The goal
is to produce a docs-only proposal packet that a human can inspect. RunForge must
not mutate the target repo during this trial.

## What RunForge Can Do Today

- Build a deterministic local artifact packet for a task.
- Collect scoped context from a local repository.
- Produce a narrow docs-only proposal patch when given a target file, anchor
  text, insertion text, and rationale.
- Write one complete external proposal packet: `human-review.md`,
  `context-pack.json`, `context-pack.md`, `proposal.patch`,
  `patch-summary.md`, `safety-report.json`, `run-spec.json`, and
  `trajectory.json`.
- Validate declared evidence files before generating a proposal patch.
- Validate a proposal manually with `git apply --check`.

## What RunForge Cannot Do Yet

- It is not a SaaS product, dashboard, daemon, queue, or remote compute system.
- It does not call an LLM or external API for this flow.
- It does not apply patches automatically.
- It does not open PRs, push branches, merge code, or manage credentials.
- It does not infer arbitrary code fixes. The alpha external path is a
  deterministic docs proposal workflow.

## Prerequisites

- Node.js 20 or newer.
- `pnpm install` has been run in the RunForge repo.
- A separate local target repo you are willing to read from.
- A docs-only task with a known file and exact anchor text.
- A clean target repo before the trial.

Check the target repo first:

```bash
cd /path/to/target-repo
git status --short
```

## Run The MVP Demo

From the RunForge repo:

```bash
pnpm demo:mvp
```

The demo writes `artifacts/mvp-demo/sample-js-fix/`. Start with:

- `human-review.md`
- `proposal/proposal.patch`
- `proposal/patch-summary.md`
- `safety-report.json`
- `trajectory.json`

This proves the local packet flow on a checked-in fixture before you point
RunForge at another repo.

## Run The Built-In External Docs Proposal Demo

The built-in script defaults to Evgeny's local SmartSQL path, but you can point
it at a different local repo with environment variables:

```bash
RUNFORGE_EXTERNAL_REPO=/path/to/target-repo \
RUNFORGE_EXTERNAL_OUT=artifacts/runs/external-docs-proposal \
pnpm demo:external-docs-proposal
```

The script writes a packet under:

```text
artifacts/runs/external-docs-proposal/packet/
```

Inspect:

- `human-review.md`
- `proposal.patch`
- `patch-summary.md`
- `context-pack.md`
- `proposal-status.json`
- `safety-report.json`
- `run-spec.json`

If the target repo does not contain the expected demo anchor, use the reusable
spec template below instead of changing the target repo.

## Run The External Docs Proposal CLI

For custom docs proposals, prefer the CLI wedge when you already know the
target file, exact anchor, insertion text, and evidence files:

````bash
pnpm dev external docs-proposal \
  --repo /path/to/target-repo \
  --target README.md \
  --evidence README.md \
  --evidence package.json \
  --anchor "exact text already present in README.md" \
  --insert "\n\nDocument the existing command declared in package.json." \
  --rationale "package.json defines the command" \
  --out artifacts/runs/external-docs-cli
````

Factory-style example for documenting an existing root build command:

````bash
pnpm dev external docs-proposal \
  --repo /Users/evgeny/Documents/projects/factory \
  --target README.md \
  --evidence README.md \
  --evidence package.json \
  --anchor "## Development" \
  --insert "\n\nThe root build command is declared in package.json:\n\n```bash\nnpm run build\n```" \
  --rationale "package.json defines the build script" \
  --out /tmp/runforge-factory-docs
````

The CLI validates that `--repo` exists, `--target` and every repeated
`--evidence` file exist under that repo, paths cannot traverse outside the repo,
`--anchor` is present in the target file, and at least one evidence file was
declared. It then generates and validates the RunSpec internally, preserving:

- `input.allowExternalRepo: true`
- `safety.repoWritesAllowed: false`
- `safety.networkAllowed: false`
- `safety.applyMode: "patch-artifact"`

The output packet is proposal-only. RunForge writes artifacts, runs no LLM/API
call, does not apply the patch, does not push, does not merge, and does not
mutate the external repo.

## Run A Custom External Docs Proposal

Copy `examples/runspecs/external-docs-proposal.template.json` to a scratch file
outside version control or to an ignored path, then edit:

- `input.repoPath`
- `input.include`
- `input.exclude`
- `input.docsProposal.targetFile`
- `input.docsProposal.anchorText`
- `input.docsProposal.insertedText`
- `input.docsProposal.rationale`
- `input.docsProposal.evidenceFiles`
- `outDir`

Every file named in `input.docsProposal.evidenceFiles` must exist under the
target repository root, be readable, and be selected by `input.include` after
`input.exclude`. RunForge will not generate a patch if declared evidence is
missing or excluded.

Keep these safety settings:

- `input.allowExternalRepo: true`
- `safety.repoWritesAllowed: false`
- `safety.networkAllowed: false`
- `safety.applyMode: "patch-artifact"`

Run the spec:

```bash
pnpm dev run --spec /path/to/edited-external-docs-proposal.json
```

RunForge rejects external `repoPath` values unless `input.allowExternalRepo` is
explicitly `true`. Include/exclude patterns must be relative POSIX paths scoped
inside the target repo. Avoid broad includes such as `**/*` for alpha trials.

## Inspect The Human Review Packet

Open the emitted `human-review.md` first. Confirm:

- The task matches what you intended.
- Status is understood. `blocked` can be expected for proposal-only work because
  a human decision is required; check the summary for `proposal_ready`,
  `no_proposal_generated`, or `evidence_missing`.
- The artifact paths point to the proposal and safety files.
- The summary does not claim that the target repo was changed.
- The context pack and proposal summary cite only files included in the packet.

## Inspect The Proposal Patch

Open `proposal.patch`.

- A useful proposal should be non-empty and contain a unified diff.
- If it is empty, read `patch-summary.md` and `proposal-status.json`; common
  reasons are missing evidence, missing target file, anchor text not found, or
  requested text already present.
- Do not apply the patch during the trial unless you intentionally leave the
  RunForge alpha flow and make a manual human decision.

## Check The Patch Without Applying It

From the target repo:

```bash
git apply --check /absolute/path/to/proposal.patch
```

This checks whether the patch can apply cleanly. It does not apply the patch.
Record the result in `docs/templates/external-dogfood-report.md`.

## Confirm The Target Repo Stayed Clean

From the target repo:

```bash
git status --short
```

Expected result: no changes caused by RunForge. If the repo was dirty before
the trial, compare against the before snapshot you recorded.

Also check the RunForge repo:

```bash
cd /path/to/runforge
git status --short
```

Generated alpha artifacts may appear under `artifacts/`; source files should not
change unless you intentionally edited RunForge itself.

## What To Report Back

Use `docs/templates/external-dogfood-report.md` and include:

- Project tested.
- Task chosen.
- Command or spec used.
- Artifact paths.
- Whether `proposal.patch` was non-empty.
- `git apply --check` result.
- Target repo before/after status.
- RunForge repo status.
- What worked.
- What was confusing.
- Verdict: `USEFUL_NOW`, `USEFUL_WITH_FRICTION`, or `NOT_USEFUL_YET`.
