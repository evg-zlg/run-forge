# ADMIN-UI-3 Validation

Branch: codex/admin-ui-3-run-browser
Commit SHA: c8a18d0
Worktree dirty during evidence: true
Admin output path: /tmp/runforge-admin-ui
Admin index path: /tmp/runforge-admin-ui/index.html
Admin data path: /tmp/runforge-admin-ui/admin-data.json

## Checks

- Indexed runs loaded: 7
- Text filter result count: 1
- Repo/alpha/outcome/provider filter result count: 1
- Urgent/safety filter result count: 7
- Detail graph nodes for first run: 51
- Events timeline present: true
- Fallback timeline present: false
- Artifact/deep links for first run: 32
- Compare changed fields: 13
- Artifact route allowed status: 200
- Artifact route traversal rejection: 403
- Raw token value rendered: false

## Commands Run

- pnpm validation:admin-ui-3

## Additional Validation Run After Script

- pnpm check:governance: passed
- pnpm check:structure: passed; existing warning-only long files remain
- pnpm typecheck: passed
- pnpm test: passed, 17 files / 152 tests
- pnpm exec vitest run tests/unit/admin-ui.test.ts: passed, 1 file / 21 tests
- pnpm validation:packets: passed
- pnpm build: passed
- pnpm validation:alpha15: passed
- pnpm validation:alpha16: passed
- pnpm validation:okf: passed
- pnpm demo:admin-ui: passed, 7 runs
- pnpm demo:admin-ui-2: passed, 7 runs
- pnpm demo:admin-ui-3: passed, 7 runs
- pnpm dev admin serve --config /tmp/runforge-admin-ui-config.json --out /tmp/runforge-admin-ui-visual --port 0: passed for visual review, stopped

## Safety

- No provider APIs were called.
- No repositories were mutated.
- Artifact server smoke was localhost-only, read-only, and shut down.
- Artifact route rejected a path outside configured run roots.

## Known Limitations

- Browser file:// opening remains browser-policy dependent; absolute paths and copy buttons are always rendered.
- Compare view is intentionally lightweight and field-based.

ADMIN-UI-3 validation: passed
