# RunForge

RunForge is a local CLI and artifact-first engineering harness for turning an engineering task into a reviewable result. Its stable HTTP contract is public for clients on the same machine at a localhost URL; RunForge is not a network-remote or SaaS service. Its official external workflow is `onboarding` → project-aware `doctor` → TaskSpec v2 → `task-run start` → `results.json` and `summary.md` → an explicit owner gate when needed.

The localhost control plane can also execute capability-gated bounded implementation through a real local coding-agent backend. Implementation runs in disposable Git worktrees, returns local commit/patch evidence, and leaves remote publication behind a separate owner gate.

It solves the "what did the agent see, do, and propose?" problem for local code work. Instead of hiding work inside an autonomous run, RunForge writes the task, context, command evidence, trajectory, safety report, patch proposal, and human review packet to disk so a person can inspect the decision trail before anything is applied.

The localhost control plane is a public, versioned API for local clients, but it does not accept non-loopback binds or non-local browser origins. RunForge is not a network-remote daemon, MCP server, watched queue, SaaS service, automatic merge system, or deploy service. Legacy `run`, `external`, and flag-based `task-run` surfaces remain compatible, but TaskSpec v2 is the recommended new-session intake.

## Quick start for a new session

With the installed CLI, run:

```bash
runforge onboarding --format json
runforge onboarding --repo /absolute/path/to/project --format json
runforge doctor --repo /absolute/path/to/project --runtime docker --format json
runforge task-run start --spec /absolute/path/to/task.runforge.json
```

From this checkout, replace `runforge` with `corepack pnpm dev`. Start with [docs/GETTING_STARTED_FOR_AGENTS.md](docs/GETTING_STARTED_FOR_AGENTS.md). Local HTTP clients should use the [Execution Agreement guide](docs/EXECUTION_AGREEMENTS.md) and the published [TaskSpec v2](schemas/task-spec-v2.schema.json), [Execution Agreement v1](schemas/execution-agreement-v1.schema.json), [task result v1](schemas/task-result-v1.schema.json), and [control-plane v1](schemas/control-plane-v1.schema.json) schemas. Every TaskSpec run has two official entry artifacts at its configured artifact root:

- `results.json` — normalized, machine-readable task result v1;
- `summary.md` — concise human result and next action.

Onboarding and doctor are read-only. `runforge onboarding --repo /path --write-project-file` is the explicit exception: it creates an uncommitted `RUNFORGE.md`, refuses to overwrite one, and does not change Git history.

## Alpha Trial

For a first local external-repo trial, read [docs/alpha-trial-guide.md](docs/alpha-trial-guide.md).

## Alpha status

RunForge alpha has passed external docs proposal validation on SmartSQL, PartKom B2C, and Factory with proposal-only packets, `git apply --check` success, and no target-repo mutation. See [docs/alpha-snapshot-2026-07-02.md](docs/alpha-snapshot-2026-07-02.md).

Start with the fixture MVP:

```bash
pnpm install
pnpm demo:mvp
```

Before external trials, make sure the RunForge checkout is current:

```bash
git fetch origin
git pull --ff-only
git rev-parse HEAD
pnpm dev --version
```

Then run the docs-only external proposal flow:

```bash
pnpm demo:external-docs-proposal
```

Run explicit checks against an external local repository in an isolated
workspace:

```bash
pnpm dev external check \
  --repo /path/to/target-repo \
  --command "pnpm build" \
  --command "pnpm test" \
  --exit-policy packet \
  --out ./artifacts/runs/external-check
```

`external check` runs user-provided commands in a disposable copied workspace,
not in the original repository. It records original repo `HEAD` and
`git status --short` before and after the run; original repo mutation is not
allowed. Defaults are `--timeout-ms 120000` and
`--max-log-bytes 1000000`.

The copied workspace is intentionally not treated as a Git repository. RunForge
captures a filesystem snapshot before and after commands and records added,
modified, and deleted files in `workspace.changeSummary` using
`method: "filesystem_snapshot"`. If the snapshot diff cannot be computed, the
packet records `status: "unknown"` and an error instead of silently claiming a
clean workspace.

Multi-command checks currently continue after a failed command. The final
packet status becomes `failed` when any command fails, `timed_out` when any
command times out, and otherwise follows blocked/error/passed status. This is
recorded in `commandPolicy` in `run.json` and repeated in `summary.md`.

CLI exit behavior is explicit. The default `--exit-policy packet` exits `0`
when RunForge successfully produces a complete packet, even if the command
status is `failed` or `timed_out`; RunForge internal errors still exit non-zero.
Use `--exit-policy command-status` for automation that should exit non-zero when
the final packet status is `failed`, `timed_out`, `blocked`, or `error`.

The disposable copy excludes dependency/build cache directories such as
`node_modules`. Commands requiring installed dependencies should include
setup/install steps or use a future workspace policy that supplies dependencies.
Such failures are evidence in the packet, not mutation of the original repo.

Each run writes `packet/summary.md`, `packet/run.json`,
`packet/events.jsonl`, `packet/metrics.json`,
`packet/command-results.json`, `packet/safety-report.json`,
`packet/trajectory.json`, `packet/packet-manifest.json`, and per-command logs
under `packet/logs/`. Start with `summary.md` for the human verdict, then
inspect failed command logs. `events.jsonl` is the future UI route/worker trace
with stable event, worker, command, and artifact IDs. `metrics.json` captures
run comparison fields including timing, command counts, log bytes, truncation
counts, workspace change counts, original repo baseline/mutation verdict, and
per-command summaries.

Analyze a failed external check packet without applying changes:

```bash
pnpm dev external failure-triage \
  --from-check-packet ./artifacts/runs/external-check/packet \
  --out ./artifacts/runs/external-failure-triage
```

Or have failure triage create the source check packet first:

```bash
pnpm dev external failure-triage \
  --repo /path/to/target-repo \
  --command "pnpm test" \
  --out ./artifacts/runs/external-failure-triage
```

`external failure-triage` writes `packet/summary.md`,
`packet/human-review.md`, `packet/failure-triage.md`,
`packet/root-cause.json`, `packet/evidence-excerpts.md`,
`packet/safe-next-action.md`, `packet/run.json`, `packet/events.jsonl`,
`packet/metrics.json`, `packet/safety-report.json`, and
`packet/trajectory.json`. It classifies practical failure categories such as
dependency setup, typecheck errors, test assertion failures, build failures,
timeouts, command-not-found errors, and unknown failures. If the source packet
passed, it records `no_failure_observed` instead of inventing a root cause.

Or create a proposal-only packet directly from flags, without hand-writing
RunSpec JSON:

````bash
pnpm dev external docs-proposal \
  --repo /path/to/target-repo \
  --target README.md \
  --evidence README.md \
  --evidence package.json \
  --anchor "npm run build" \
  --insert "\n\nThe build command is declared in package.json:\n\n```bash\nnpm run build\n```" \
  --rationale "package.json defines the build script" \
  --out ./artifacts/runs/external-docs-cli
````

For multiline anchors or insertions, prefer file inputs:

````bash
pnpm dev external docs-proposal \
  --repo /path/to/target-repo \
  --target README.md \
  --evidence README.md \
  --evidence package.json \
  --anchor-file ./examples/external-docs-proposal-inputs/anchor.txt \
  --insert-file ./examples/external-docs-proposal-inputs/insert.md \
  --rationale-file ./examples/external-docs-proposal-inputs/rationale.md \
  --out ./artifacts/runs/external-docs-cli-files
````

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

For external command checks:

```bash
runforge external check \
  --repo /path/to/target-repo \
  --command "pnpm build" \
  --command "pnpm test" \
  --exit-policy command-status \
  --out ./runforge-artifacts/external-check
```

This produces a reviewable packet without applying fixes, pushing, merging, or
deploying. The original repo is audited before and after the disposable
workspace run. Use `--exit-policy packet` when packet production success should
exit `0`; use `--exit-policy command-status` when failed/timed-out command
evidence should make automation fail.

For external docs proposals:

````bash
runforge external docs-proposal \
  --repo /path/to/target-repo \
  --target README.md \
  --evidence README.md \
  --evidence package.json \
  --anchor "exact text already in README.md" \
  --insert "\n\nNew docs text supported by the evidence files." \
  --rationale "why the evidence supports this insertion" \
  --out ./runforge-artifacts/external-docs
````

Use `--anchor-file`, `--insert-file`, and `--rationale-file` for multiline
text. Each file flag is mutually exclusive with its direct text flag.

The command generates a normal validated RunSpec internally with
`allowExternalRepo: true`, `repoWritesAllowed: false`, and
`networkAllowed: false`. It writes `packet/human-review.md`,
`packet/proposal-status.json`, `packet/proposal.patch`, and
`packet/patch-summary.md`, but it does not apply, push, merge, call an LLM/API,
or mutate the external repository. The final CLI summary prints the RunForge
version, local git SHA, packet directory, proposal outcome, key artifact paths,
a `git apply --check` suggestion, and a reminder that the patch was not applied.

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

````bash
pnpm dev doctor
pnpm dev onboarding --format json
pnpm dev doctor --repo /absolute/path/to/project --runtime docker --format json
pnpm dev task-run start --spec /absolute/path/to/task.runforge.json
pnpm dev init --safe
pnpm dev run --task context-pack --repo ./fixtures/repos/sample-js --goal "Prepare local context" --out ./artifacts/rails-context
pnpm dev external docs-proposal --repo ./tests/fixtures/external-docs-repo --target README.md --evidence README.md --evidence package.json --anchor "npm run dev\n```" --insert "\n\nFor the stable frontend dev path, use the existing root command:\n\n```bash\nnpm run dev:stable\n```" --out ./artifacts/runs/external-docs-cli-demo
pnpm dev triage --repo ./fixtures/repos/sample-js --log ./fixtures/logs/typecheck-failure.log --out ./artifacts/demo-typecheck
pnpm check:governance
pnpm check:structure
pnpm test
pnpm dogfood
````

The default provider is deterministic and local. `openai-compatible` is only a skeleton and is never required for tests.
TaskSpec v2 is the recommended external intake and is documented in [docs/GETTING_STARTED_FOR_AGENTS.md](docs/GETTING_STARTED_FOR_AGENTS.md), with its schema in [schemas/task-spec-v2.schema.json](schemas/task-spec-v2.schema.json). RunSpec v1 is a supported legacy surface documented in [docs/runspec.md](docs/runspec.md).

## Safety

MVP triage is read-only against the target repository. RunForge writes only to the requested artifact directory and does not execute repository commands.

See [docs/demo-walkthrough.md](docs/demo-walkthrough.md), [docs/product-scope.md](docs/product-scope.md), [docs/safety-model.md](docs/safety-model.md), [docs/run-rails.md](docs/run-rails.md), [docs/runspec.md](docs/runspec.md), [docs/security-model.md](docs/security-model.md), [docs/report-contract.md](docs/report-contract.md), [docs/ai-native-codebase.md](docs/ai-native-codebase.md), [docs/engineering-rules.md](docs/engineering-rules.md), and [docs/dogfooding.md](docs/dogfooding.md).
