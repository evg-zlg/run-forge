# RunForge

RunForge is a local agentic engineering harness for turning an engineering task into a reviewable artifact packet. The current MVP demonstrates one safe loop: collect task context, capture deterministic check evidence, generate a proposal-only patch, record safety decisions, and hand the result to a human reviewer.

It solves the "what did the agent see, do, and propose?" problem for local code work. Instead of hiding work inside an autonomous run, RunForge writes the task, context, command evidence, trajectory, safety report, patch proposal, and human review packet to disk so a person can inspect the decision trail before anything is applied.

RunForge is not a SaaS product, dashboard, remote compute system, queue, provider platform, LLM coding agent, auto-PR tool, auto-merge tool, or automatic patch applier. The MVP is local, deterministic, proposal-only, and human-gated.

## Alpha Trial

For a first local external-repo trial, read [docs/alpha-trial-guide.md](docs/alpha-trial-guide.md).

Start with the fixture MVP:

```bash
pnpm install
pnpm demo:mvp
```

Then run the docs-only external proposal flow:

```bash
pnpm demo:external-docs-proposal
```

Use [examples/runspecs/external-docs-proposal.template.json](examples/runspecs/external-docs-proposal.template.json) for a custom local target repo and [docs/templates/external-dogfood-report.md](docs/templates/external-dogfood-report.md) to report the result.

Run the MVP demo:

```bash
pnpm install
pnpm demo:mvp
```

The demo writes `artifacts/mvp-demo/sample-js-fix/`.

Start with:

- `human-review.md`
- `task.md`
- `proposal/proposal.patch`
- `proposal/patch-summary.md`
- `safety-report.json`
- `trajectory.json`

RunForge routes engineering tasks through explicit rails:

```text
Run -> Task -> SafetyPolicy -> Context -> Execution -> Artifacts -> Trajectory -> Report -> Human decision
```

## Rails MVP

RunForge supports five local task types:

- `failure-triage`
- `command-check`
- `repo-research`
- `context-pack`
- `code-proposal`

Every `runforge run` invocation writes a run directory under `--out` with:

```text
run.json
review.md
human-review.md
trajectory.json
safety-report.json
context-summary.json
run-spec.json
```

Task-specific artifacts are written beside those common files. The original failure triage task still writes:

```text
failure-triage/review.md
failure-triage/trajectory.json
failure-triage/safety-report.json
failure-triage/context-summary.json
```

`code-proposal` is first-class but gated. It is proposal-first, writes `proposal.patch` and `patch-summary.md`, never writes directly to the target repository, never pushes, never merges, and always requires a human decision before apply. Today it is deterministic and fixture-based, not an LLM coder: the sample-js fixture can produce a reviewable unified diff, while unmatched repositories may produce an empty patch artifact.

## Legacy triage command

The focused failure triage command remains available. It reads a failure log and a repository path, performs bounded read-only inspection, and writes structured artifacts:

```text
review.md
trajectory.json
safety-report.json
context-summary.json
```

## Usage

```bash
pnpm install
pnpm demo:typecheck-failure
```

Or from any project:

```bash
runforge init --safe
runforge triage --repo . --log ./failure.log --out ./runforge-artifacts/case-001
runforge run --task repo-research --repo . --goal "Map package scripts" --out ./runforge-artifacts
runforge run --task code-proposal --repo . --goal "Propose a fix" --out ./runforge-artifacts
runforge run --task command-check --repo . --command "pnpm test" --safety-profile trusted-local --out ./runforge-artifacts
runforge run --spec ./examples/runspecs/command-check-typecheck.json
```

For the controlled fixture proposal demo:

```bash
pnpm demo:spec-code-proposal-fixture
```

Inspect `patch-summary.md` and `proposal.patch` in the emitted run directory. If a human accepts the proposal, they can apply it manually outside RunForge with `git apply path/to/proposal.patch`.

## Run the MVP demo

```bash
pnpm install
pnpm demo:mvp
```

This writes a complete local demo packet to `artifacts/mvp-demo/sample-js-fix/`.

Inspect these first:

- `artifacts/mvp-demo/sample-js-fix/human-review.md` - reviewer-oriented summary and next step.
- `artifacts/mvp-demo/sample-js-fix/task.md` - the task RunForge attempted.
- `artifacts/mvp-demo/sample-js-fix/context/context-pack.md` - the collected fixture context.
- `artifacts/mvp-demo/sample-js-fix/checks/command-output.txt` - deterministic command evidence.
- `artifacts/mvp-demo/sample-js-fix/proposal/proposal.patch` - proposal-only unified diff.
- `artifacts/mvp-demo/sample-js-fix/proposal/patch-summary.md` - patch summary and human gate.
- `artifacts/mvp-demo/sample-js-fix/safety-report.json` - safety decisions for the packet.
- `artifacts/mvp-demo/sample-js-fix/trajectory.json` - end-to-end demo trajectory.

The demo proves the current local harness can compose task context, deterministic failure evidence, gated code proposal artifacts, `git apply --check` validation, and a human review packet without mutating the fixture repo.

It does not prove hosted execution or autonomous delivery. There is no LLM/API call yet, no repo mutation, no auto-PR, no auto-merge, and no automatic patch application. The patch is proposal-only; a human applies or approves it manually.

## Commands

```bash
pnpm dev doctor
pnpm dev init --safe
pnpm dev run --task context-pack --repo ./fixtures/repos/sample-js --goal "Prepare local context" --out ./artifacts/rails-context
pnpm dev triage --repo ./fixtures/repos/sample-js --log ./fixtures/logs/typecheck-failure.log --out ./artifacts/demo-typecheck
pnpm check:governance
pnpm check:structure
pnpm test
pnpm dogfood
```

The default provider is deterministic and local. `openai-compatible` is only a skeleton and is never required for tests.
RunSpec files are documented in [docs/runspec.md](docs/runspec.md), with examples in [examples/runspecs](examples/runspecs).

## Safety

MVP triage is read-only against the target repository. RunForge writes only to the requested artifact directory and does not execute repository commands.

See [docs/demo-walkthrough.md](docs/demo-walkthrough.md), [docs/product-scope.md](docs/product-scope.md), [docs/safety-model.md](docs/safety-model.md), [docs/run-rails.md](docs/run-rails.md), [docs/runspec.md](docs/runspec.md), [docs/security-model.md](docs/security-model.md), [docs/report-contract.md](docs/report-contract.md), [docs/ai-native-codebase.md](docs/ai-native-codebase.md), [docs/engineering-rules.md](docs/engineering-rules.md), and [docs/dogfooding.md](docs/dogfooding.md).
