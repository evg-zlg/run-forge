# EXTERNAL-RUN-3 External Execution Readiness Report

## Classifications

- RunForge capability: `passed`
- External target: `passed`

## Readiness Evidence

- RunForge base SHA: `95e3d8050110597ccbe8b9f6d805340188cbc793`
- RunForge final SHA: `95e3d8050110597ccbe8b9f6d805340188cbc793` (implementation is present as an uncommitted working-tree change; no commit was requested)
- Target: `/Users/evgeny/Documents/projects/factory`
- HEAD before: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- HEAD after: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- Status before: clean
- Status after: clean
- Original repository changed: no
- Preparation strategy: `disposable-workspace-snapshot`
- Package manager: `npm`
- Lockfile hash: `848a8ca54f03c062c557d29edd0b00985368da29518405d861c5b6a798c2c1ce`
- Preparation network used: yes
- Runtime execution network: `none`
- Docker image: `runforge:local` (sha256:44dc2dd1e3af867ff1c8346761bcc7451a4852fe2bf6f20e39dc4cd87765fa14)
- Docker runtime policy: `--pull never`, `--network none`, read-only container root, no-new-privileges, all Linux capabilities dropped, 512 PID / 2 GiB / 2 CPU limits; only the disposable prepared workspace and its temp directory are writable source mounts
- Providerless review: `accepted` via `deterministic-evidence-reviewer`

## Exact Command

```bash
corepack pnpm dev task-run start \
  --task "Run full external repository validation readiness loop" \
  --repo /Users/evgeny/Documents/projects/factory \
  --runtime docker \
  --docker-image runforge:local \
  --prepare-runtime explicit \
  --check-command "corepack pnpm check:governance && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build" \
  --out validation/runs/EXTERNAL-RUN-3
```

## Validation

- `npm run typecheck`: passed (exit 0)
- `npm test`: passed (exit 0)
- `npm run build`: passed (exit 0)

RunForge check: `corepack pnpm check:governance && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build` -> passed.

Packet validation: `passed` for nested packet `packet-check/packet`; its manifest hashes, required artifacts, events, metrics, safety report, and command results validated successfully.

## Artifacts And Blockers

- Artifacts: `summary.md`, `results.json`, `runtime-preparation-report.md`, `execution-log.md`, `environment.json`, `provenance.json`, this report, review evidence, three executor packets, and `packet-check/packet`.
- Patch package: not produced because the target passed.
- Blockers: none.
- Prohibited actions: no provider call, secret read, database, production, deploy, push, merge, commit, or auto-apply occurred.

## Owner Guidance

The external repository is reproducibly runnable in the prepared offline Linux contour; no patch package is needed.

EXTERNAL-RUN-3 proves practical value: a macOS dependency snapshot that previously failed on Linux was replaced by a provenance-recorded Linux/arm64 dependency environment, after which the real Factory suite reached and passed 69 files / 712 tests offline.

Recommended next large milestone: `EXTERNAL-RUN-4 — Safe Disposable Repair Execution`.
