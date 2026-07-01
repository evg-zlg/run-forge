# RunForge

RunForge is a local Agentic Engineering Harness.
It routes engineering tasks through explicit rails:

```text
Run -> Task -> SafetyPolicy -> Context -> Execution -> Artifacts -> Trajectory -> Report -> Human decision
```

RunForge - harness для агентной инженерии. Сначала он помогает безопасно разбирать CI/debug failures в Docker.

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

See [docs/run-rails.md](docs/run-rails.md), [docs/runspec.md](docs/runspec.md), [docs/security-model.md](docs/security-model.md), [docs/report-contract.md](docs/report-contract.md), [docs/ai-native-codebase.md](docs/ai-native-codebase.md), [docs/engineering-rules.md](docs/engineering-rules.md), and [docs/dogfooding.md](docs/dogfooding.md).
