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
