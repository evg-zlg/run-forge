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
