# Dogfooding RunForge

Use `pnpm dogfood` as the local all-up check before handing off a change. It runs governance, structure, typecheck, tests, build, validation, and the three fixture demos.

Use `pnpm dogfood:rails` when changing the unified run rails or before release-like handoff. It first builds the local package bin, then runs a deterministic subset of RunForge's own checks through `runforge run --task command-check`:

```text
pnpm check:structure
pnpm check:governance
pnpm typecheck
pnpm test
pnpm build
pnpm validation:run
```

The rails dogfood output is namespaced under `artifacts/runs/dogfood-rails/<check>/<run-id>/`. Each check must include the common rails artifacts (`run.json`, `review.md`, `trajectory.json`, `safety-report.json`, `context-summary.json`) plus `command-result.json` and `command-output.txt`.

`pnpm dogfood:rails` proves that RunForge can route its own local checks through command-check rails, preserve the command-result schema, and leave inspectable artifacts for every command. It does not prove hosted execution, remote scheduling, reviewer quality, or automatic code application. It is local-first only: commands run in the current checkout with `trusted-local`, artifacts stay under ignored local `artifacts/`, and no push or merge path is involved.

`pnpm dogfood` does not call `pnpm dogfood:rails`. Keeping them separate avoids recursive dogfood loops and keeps the default handoff check from becoming slower than necessary.

When RunForge itself fails, save the failing command output as a local artifact and triage it with RunForge:

```bash
mkdir -p artifacts
pnpm typecheck > artifacts/runforge-failure.log 2>&1
pnpm dev:triage -- --repo . --log artifacts/runforge-failure.log --out artifacts/dogfood-runforge
```

Swap `pnpm typecheck` for the failing command. The triage output stays local under `artifacts/`, which is ignored except for `.gitkeep`.

Dogfood reports are not proof that RunForge is correct. They are evidence that the artifact contract still works on RunForge's own failure shape.

`code-proposal` remains gated even in dogfood. It emits `proposal.patch` and `patch-summary.md` as local artifacts, requires a human decision, and does not mutate the target repository by default.
