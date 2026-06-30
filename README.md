# RunForge

RunForge is an Agentic Engineering Harness.
First, it helps teams triage CI and debug failures safely in Docker.

RunForge - harness для агентной инженерии. Сначала он помогает безопасно разбирать CI/debug failures в Docker.

## MVP

RunForge's first wedge is a local Failure Triage Harness. It reads a failure log and a repository path, performs bounded read-only inspection, and writes structured artifacts:

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
```

## Commands

```bash
pnpm dev -- doctor
pnpm dev -- init --safe
pnpm dev:triage -- --repo ./fixtures/repos/sample-js --log ./fixtures/logs/typecheck-failure.log --out ./artifacts/demo-typecheck
pnpm check:structure
pnpm test
```

The default provider is deterministic and local. `openai-compatible` is only a skeleton and is never required for tests.

## Safety

MVP triage is read-only against the target repository. RunForge writes only to the requested artifact directory and does not execute repository commands.

See [docs/security-model.md](docs/security-model.md), [docs/report-contract.md](docs/report-contract.md), and [docs/ai-native-codebase.md](docs/ai-native-codebase.md).
