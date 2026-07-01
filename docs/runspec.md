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

### External Repository Context

By default, `context-pack` rejects a `repoPath` outside the current RunForge
workspace. External local repositories are supported only when the RunSpec
declares that intent explicitly:

```json
{
  "schemaVersion": 1,
  "taskType": "context-pack",
  "runId": "external-docs-context",
  "artifactNamespace": "external-dogfood",
  "input": {
    "repoPath": "/Users/evgeny/Documents/projects/smartsql",
    "allowExternalRepo": true,
    "include": [
      "README.md",
      "package.json",
      "docs/BUILD_STABILITY.md"
    ],
    "exclude": [
      "node_modules/**",
      "dist/**",
      ".git/**",
      "output/**",
      "tmp/**",
      "reports/**"
    ],
    "maxBytesPerFile": 12000
  },
  "safety": {
    "repoWritesAllowed": false,
    "networkAllowed": false
  }
}
```

The opt-in flag exists so a broad or mistyped absolute path cannot silently
expand RunForge's read surface. Include/exclude patterns are preserved in the
normalized spec and reflected in `context-pack.json` and `context-pack.md`.
Traversal patterns such as `../README.md` are rejected, and file reads are
checked against the declared external root. Default skips also exclude `.git`,
`node_modules`, build outputs, `tmp`, `output`, and `reports`.

This proves RunForge can produce a reusable, deterministic context bundle while
staying read-only and local. It is intended to feed later proposal or agent
workflows as reviewed input context. It does not apply patches, mutate the
repository, run remote jobs, call model APIs, or create provider integrations.

`examples/runspecs/code-proposal-fixture-fix.json` demonstrates the fixture
`code-proposal` path. It targets the controlled `fixtures/repos/sample-js`
fixture and proposes a deterministic unified diff for a known calculator
assertion.

`code-proposal` also supports a narrow deterministic `input.docsProposal` mode
for docs-only README proposals:

```json
{
  "schemaVersion": 1,
  "taskType": "code-proposal",
  "runId": "external-docs-proposal",
  "artifactNamespace": "external-dogfood",
  "input": {
    "repoPath": "/Users/evgeny/Documents/projects/smartsql",
    "allowExternalRepo": true,
    "docsProposal": {
      "targetFile": "README.md",
      "anchorText": "npm run dev\n```",
      "insertedText": "\n\nFor the stable frontend dev path, use the existing root command:\n\n```bash\nnpm run dev:stable\n```",
      "rationale": "`package.json` exposes a root `dev:stable` script, and docs/BUILD_STABILITY.md documents it as the stable local development path.",
      "evidenceFiles": [
        "README.md",
        "package.json",
        "docs/BUILD_STABILITY.md"
      ]
    }
  },
  "safety": {
    "repoWritesAllowed": false,
    "networkAllowed": false
  }
}
```

This mode is deterministic and non-LLM. It reads the target file, finds the
anchor text, writes a proposal-only unified diff to `proposal.patch`, and leaves
the target repository unchanged. If the target file, anchor, or requested text
state prevents a deterministic patch, `proposal.patch` remains empty and
`patch-summary.md` explains why instead of silently pretending a proposal was
created.

To review a code proposal, open `patch-summary.md` for the task summary, files proposed to change, rationale, safety status, and manual next step. Then inspect `proposal.patch`. A human may apply the patch manually outside RunForge with `git apply path/to/proposal.patch` after review.

This is not LLM coding, remote execution, auto-PR, auto-merge, automatic apply
mode, SaaS execution, or hosted provider logic. It writes reviewable artifacts
only.

## SmartSQL External Dogfood

Run the local external docs proposal dogfood with:

```sh
RUNFORGE_EXTERNAL_REPO=/Users/evgeny/Documents/projects/smartsql pnpm demo:external-docs-proposal
```

The command produces a combined packet under
`artifacts/runs/external-docs-proposal/packet`:

- `human-review.md`
- `context-pack.json`
- `context-pack.md`
- `proposal.patch`
- `patch-summary.md`
- `safety-report.json`
- `trajectory.json`
- `run-spec.json`

The demo verifies that `proposal.patch` is non-empty and that
`git apply --check proposal.patch` accepts the patch against the external repo.
It does not apply the patch and does not write to SmartSQL. Tests use a local
fixture external repo so CI does not depend on the SmartSQL path existing.

Current limitations: `docsProposal` is intentionally narrow. It inserts
reviewed text after an exact anchor in one target file and does not perform
semantic rewriting, multi-file edits, provider calls, or automatic application.

## Difference From Demo Scripts

Demo scripts are convenient shortcuts maintained by the repository. A RunSpec is
the portable contract for one run: task type, inputs, artifact placement, and
safety intent live in one reviewed JSON file. Demo scripts may call RunSpec
files, but the spec remains the reproducible source of truth.
