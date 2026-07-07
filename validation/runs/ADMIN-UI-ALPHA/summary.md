# RunForge Admin UI Alpha Validation

Generated at: 2026-07-07T03:30:33.880Z

## Scope

Built the first local RunForge Admin UI / Operator Console as a static, local-only HTML artifact.

## Demo

- Config file used: `/tmp/runforge-admin-ui-config.json`
- Admin output path: `/tmp/runforge-admin-ui/index.html`
- Admin data path: `/tmp/runforge-admin-ui/admin-data.json`

## Loaded Data

- Repositories loaded: 1
- Providers loaded: 2
- Runs loaded: 6
- Latest validation alpha: ALPHA-10
- Run detail graphs loaded: 6

## Checks

- Config loading uses safe defaults when missing.
- OpenRouter token support uses `env:OPENROUTER_API_KEY` references.
- Env token presence is reported without rendering the token value.
- Redaction covers bearer tokens, OpenRouter key shapes, `.env`-style secret assignments, and private keys.
- Missing repository paths render as missing instead of crashing.
- Static HTML output includes overview, repositories, providers, runs/evidence, run detail graph, and settings sections.
- Static HTML output includes RunForge path, RunForge SHA, config path, and a repo filter.
- Admin UI does not call paid providers and does not mutate repositories.
- `/tmp/runforge-admin-ui/index.html` and `/tmp/runforge-admin-ui/admin-data.json` were checked for token-shaped values.

## Validation Commands

- PASS `pnpm check:governance`
- PASS `pnpm check:structure`
- PASS `pnpm typecheck`
- PASS `pnpm test` (17 files, 136 tests)
- PASS `pnpm validation:packets`
- PASS `pnpm build`
- PASS `pnpm validation:alpha15`
- PASS `pnpm validation:alpha16`
- PASS `pnpm validation:okf` (32 markdown files)
- PASS `pnpm demo:admin-ui`

## Diff Hygiene

- `validation/runs/PACKET-VALIDATION/*` regenerated timestamp/temp-path churn was reverted because it was unrelated to ADMIN-UI-ALPHA.

## Known Limitations

- UI editing is intentionally deferred; local config writes are available through `pnpm dev admin config`, `repo add`, and `provider add-*`.
- File links use `file://` URLs, which some browsers restrict for local static pages.
- Run detail graph quality depends on available packet `events.jsonl`; older packets fall back to the canonical operator path.
