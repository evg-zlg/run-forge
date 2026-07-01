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
pnpm demo:spec-context-pack-sample-js
pnpm demo:spec-code-proposal
pnpm demo:spec-code-proposal-fixture
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
`context-pack` also writes `context-pack.json` and `context-pack.md`.
`code-proposal` also writes `proposal.patch` and `patch-summary.md`.

## Context Pack

`context-pack` creates a deterministic, local-first input artifact for future
code proposal or agent runs. It gathers selected repository files, file metadata,
constraints, relevant package commands, artifact references, safety notes, and
known limitations without calling an LLM, API, hosted service, or provider.

The JSON artifact is structured for machine use:

- `schemaVersion`
- `taskType`
- `runId`
- `repoRoot`
- `includedFiles`
- `fileSummaries`
- `constraints`
- `relevantCommands`
- `artifactReferences`
- `safety`
- `limitations`

The Markdown artifact is structured for human review:

- Purpose
- Included files
- Key constraints
- Relevant commands
- Safety notes
- Limitations

Example:

```json
{
  "schemaVersion": 1,
  "taskType": "context-pack",
  "runId": "sample-js-context",
  "artifactNamespace": "examples",
  "input": {
    "repoPath": "../../fixtures/repos/sample-js",
    "include": [
      "src/**/*.ts",
      "tests/**/*.ts",
      "README.md"
    ],
    "exclude": [
      "node_modules/**",
      "dist/**"
    ],
    "maxBytesPerFile": 12000
  },
  "safety": {
    "repoWritesAllowed": false,
    "networkAllowed": false
  }
}
```

Include and exclude patterns are relative POSIX-style globs. Path traversal is
rejected, absolute include/exclude patterns are rejected, and files are read only
when they remain inside the selected repository or fixture root. Context-pack
runs enforce per-file bytes, total file count, and total byte limits. Oversized
files are represented as truncated instead of being silently expanded.

This proves RunForge can produce a reusable, deterministic context bundle while
staying read-only and local. It is intended to feed later proposal or agent
workflows as reviewed input context. It does not apply patches, mutate the
repository, run remote jobs, call model APIs, or create provider integrations.

`examples/runspecs/code-proposal-fixture-fix.json` demonstrates the current useful `code-proposal` path. It targets the controlled `fixtures/repos/sample-js` fixture and proposes a deterministic unified diff for a known calculator assertion. This is not LLM coding, remote execution, auto-PR, or auto-merge. It writes reviewable artifacts only and leaves the fixture repository unchanged.

To review a code proposal, open `patch-summary.md` for the task summary, files proposed to change, rationale, safety status, and manual next step. Then inspect `proposal.patch`. A human may apply the patch manually outside RunForge with `git apply path/to/proposal.patch` after review.

## Difference From Demo Scripts

Demo scripts are convenient shortcuts maintained by the repository. A RunSpec is
the portable contract for one run: task type, inputs, artifact placement, and
safety intent live in one reviewed JSON file. Demo scripts may call RunSpec
files, but the spec remains the reproducible source of truth.
