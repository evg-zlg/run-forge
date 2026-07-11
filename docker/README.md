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

To validate an external repository through the complete task-run loop, pass it explicitly. The target is mounted at `/source` read-only for in-container Git verification, while commands run in a separate writable disposable snapshot at `/workspace`:

```bash
corepack pnpm dev task-run start \
  --task "Run safe external repository triage" \
  --repo /absolute/path/to/repository \
  --runtime docker \
  --docker-image runforge:local \
  --out validation/runs/EXTERNAL-RUN
```

External mode defaults to `npm run typecheck`, `npm test`, and `npm run build`. Repeat `--command` to replace that list. Docker networking remains disabled, no dependency installation is attempted, and no patch is applied to the original repository. The image includes Git so every container records `/source` HEAD/status before and after its validation command. When present, the target's existing `node_modules` is reused through the read-only `/source` mount; platform-incompatible dependencies are reported as environment/setup issues rather than code failures. The bounded external profile uses 2 CPUs and 2 GiB RAM so normal TypeScript validation is not misclassified as a target failure merely because of the smaller internal-inspection default.
