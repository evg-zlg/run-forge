# Security model

RunForge MVP is safe by default.

## Defaults

- No writes to the target repository.
- Artifacts are written only to the explicit output directory.
- No repository commands are executed during triage.
- No home directory, SSH agent, Docker socket, or global environment passthrough is required.
- Logs and generated reports are scanned for secret-like values.

## Docker safe profile

The Docker wrapper follows these principles:

- non-root user
- no home mount
- no SSH agent mount
- no Docker socket mount
- no global env passthrough
- explicit repository mount
- explicit artifact output mount
- `no-new-privileges`
- Linux capabilities dropped where Docker supports it
- network disabled by default

See `docker/README.md`.
