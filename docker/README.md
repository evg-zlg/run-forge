# Docker safe run

Build locally:

```bash
docker build -t runforge:local -f docker/Dockerfile .
```

Run triage with explicit mounts:

```bash
docker/docker-run-safe.sh ./fixtures/repos/sample-js ./fixtures/logs/typecheck-failure.log ./artifacts/docker-demo
```

The wrapper mounts the repository and log read-only, mounts only the artifact output directory as writable, disables network, drops Linux capabilities, uses `no-new-privileges`, and does not mount home, SSH agent, or Docker socket.

Run task-run evidence commands in the same opt-in container lane:

```bash
pnpm dev task-run start \
  --task "Inspect the runtime implementation" \
  --out validation/runs/TASK-RUN-DOCKER \
  --runtime docker \
  --docker-image runforge:local
```

The image must already exist locally. The lane uses `--pull never`, disables network, mounts each disposable workspace read-only, drops all capabilities, and records the runtime/image in summary and JSON evidence. Local host execution remains the default.

Prepare and validate an external npm/pnpm/yarn repository without reusing host dependencies:

```bash
pnpm dev task-run start \
  --task "Run full external repository validation readiness loop" \
  --repo /absolute/path/to/external-repo \
  --runtime docker \
  --docker-image runforge:local \
  --prepare-runtime explicit \
  --out validation/runs/EXTERNAL-RUN
```

`--prepare-runtime explicit` is a distinct, owner-requested phase. It copies source into a disposable workspace, excludes `.git`, `node_modules`, build output, and secret-like `.env` files, then performs the lockfile install in Docker with preparation network enabled. Package lifecycle scripts run only inside that disposable preparation container so generated clients and native dependencies are complete. The original repository is never mounted. Typecheck, test, and build then run in separate Docker containers with `--network none`; their only writable source mounts are the disposable prepared workspace and its dedicated temporary directory. Runtime-created executables use that directory at `/runforge-tmp` (outside the target package scope) because Docker Desktop forces container tmpfs mounts to `noexec`. Provenance, preparation logs, runtime policy, command results, and before/after source Git state are written into the run artifacts.

For EXTERNAL-RUN-2-style triage without dependency preparation, use `--prepare-runtime none` and one or more explicit `--command` options. This mode mounts the original repository read-only at `/source`, runs commands in a writable disposable copy, reuses `/source/node_modules` read-only when present, and still enforces `--network none`, canonical output/tmp path guards, and the before/after source immutability gate.
