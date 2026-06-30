# Dogfooding RunForge

Use `pnpm dogfood` as the local all-up check before handing off a change. It runs governance, structure, typecheck, tests, build, validation, and the three fixture demos.

When RunForge itself fails, save the failing command output as a local artifact and triage it with RunForge:

```bash
mkdir -p artifacts
pnpm typecheck > artifacts/runforge-failure.log 2>&1
pnpm dev:triage -- --repo . --log artifacts/runforge-failure.log --out artifacts/dogfood-runforge
```

Swap `pnpm typecheck` for the failing command. The triage output stays local under `artifacts/`, which is ignored except for `.gitkeep`.

Dogfood reports are not proof that RunForge is correct. They are evidence that the artifact contract still works on RunForge's own failure shape.
