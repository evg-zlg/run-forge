# RunForge Alpha-6 Validation

Generated at: 2026-07-04T19:06:05.030Z

Raw packet paths:
- /tmp/runforge-alpha6-deterministic/packet
- /tmp/runforge-alpha6-provider-disabled/packet
- /tmp/runforge-alpha6-provider-unsafe/packet
- /tmp/runforge-alpha6-provider-valid/packet

Results:
- PASS deterministic proposal still works (exit 0)
- PASS packet inspector schema validation (exit 0)
- PASS provider disabled by default (exit 0)
- PASS provider requires explicit flag (exit 1)
- PASS unsafe provider patch is rejected (exit 0)
- PASS valid provider patch verifies in disposable workspace (exit 0)
- PASS provider packet validation json (exit 0)

Schema validation:
- Packet inspector `--validate` passed for the deterministic proposal packet.
- Packet inspector `--validate --format json` passed for the provider proposal packet.

Provider safety:
- Provider mode stayed disabled without `--enable-provider-proposal`.
- `--provider` and `--provider-command` without the explicit enable flag failed as expected.
- Unsafe `.env` provider patch was rejected before workspace apply.
- Valid provider patch applied and verified only in a disposable workspace.

Original repo mutation verdict:
- Provider fixture repo: /tmp/runforge-alpha6-provider-repo
- state.txt after all provider runs: "bad\n"
- RunForge fixture/original repos were used through disposable-workspace packet commands.

Known limitations:
- Runtime validation is lightweight and checks required artifacts/key fields, not full JSON Schema semantics.
- Provider backend is generic CLI only; no vendor-specific token, model, or cost accounting yet.
- Provider context bundle is intentionally bounded and summary artifacts avoid dumping large prompts.
