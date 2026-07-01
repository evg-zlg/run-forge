# RunSpec

RunSpec is RunForge's stable JSON input format for reproducible local runs.
It lets a run be replayed from an explicit file instead of being reconstructed
from npm demo scripts or shell history.

RunSpec is local-first only. It does not add SaaS execution, queues, remote
compute, auto-PR, auto-merge, hosted provider logic, or BYOC provider logic.

## Minimal Schema

```json
{
  "schemaVersion": 1,
  "taskType": "command-check",
  "runId": "example-command-check",
  "artifactNamespace": "examples",
  "repoPath": "../..",
  "outDir": "../../artifacts/runspec",
  "input": {
    "command": "pnpm typecheck"
  },
  "safety": {
    "repoWritesAllowed": false,
    "networkAllowed": false
  }
}
```

Supported `taskType` values:

- `failure-triage`
- `command-check`
- `repo-research`
- `context-pack`
- `code-proposal`

`schemaVersion` must be `1`. `runId` is required and must be a single safe path
segment. `artifactNamespace` is optional and follows the same path safety rules.
Path traversal and absolute path segments are rejected for both fields.

`repoPath`, `outDir`, and `input.logPath` may be relative paths. Relative paths
are resolved from the RunSpec file's directory. If omitted, `repoPath` defaults
to `.` and `outDir` defaults to `./artifacts/runspec`, both relative to the spec
file.

## Safety Defaults

RunSpec keeps the existing local rails:

- Repository writes are not allowed.
- Network enablement is not supported by RunSpec.
- Push and merge remain disabled.
- `code-proposal` stays artifact-only and requires human review.
- Dangerous `command-check` commands are rejected by the existing command safety
  policy before execution.

For `command-check`, RunSpec normalizes to `trusted-local` so the explicit
command can run after validation. Other task types normalize to `safe-local`.

## Running Specs

```sh
pnpm dev run --spec ./examples/runspecs/command-check-typecheck.json
pnpm demo:spec-command-check
pnpm demo:spec-context-pack
pnpm demo:spec-code-proposal
```

Runs from spec files persist the normalized spec at `run-spec.json` alongside
the standard root artifacts:

- `run.json`
- `review.md`
- `trajectory.json`
- `safety-report.json`
- `context-summary.json`
- `run-spec.json`

`command-check` also writes `command-result.json` and `command-output.txt`.
`code-proposal` also writes `proposal.patch` and `patch-summary.md`.

## Difference From Demo Scripts

Demo scripts are convenient shortcuts maintained by the repository. A RunSpec is
the portable contract for one run: task type, inputs, artifact placement, and
safety intent live in one reviewed JSON file. Demo scripts may call RunSpec
files, but the spec remains the reproducible source of truth.
