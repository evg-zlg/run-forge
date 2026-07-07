# ADMIN-UI-3 Visual Review

Date: 2026-07-07

## Launch

- Built demo output with `pnpm demo:admin-ui-3`.
- Served final UI with `pnpm dev admin serve --config /tmp/runforge-admin-ui-config.json --out /tmp/runforge-admin-ui-visual --port 0`.
- Final inspected URL: `http://127.0.0.1:58573/`.
- Static demo output: `/tmp/runforge-admin-ui/index.html` and `/tmp/runforge-admin-ui/admin-data.json`.

## Pages Inspected

- Overview: counts, urgent/safety table, navigation.
- Runs Browser: dense table, search/filter controls, safety badges, long paths, copy/open controls.
- Run Detail / Timeline: summary card, 51-node timeline, artifact links, collapsed JSON detail blocks.
- Compare Runs: two-run field comparison, changed-row highlighting.
- Settings: repository/provider/root editors, diagnostics, diff/save controls from ADMIN-UI-2.

## Screenshots

Screenshots were captured under `/tmp/runforge-admin-ui-3-visual/` and are intentionally not tracked:

- `/tmp/runforge-admin-ui-3-visual/overview-final-2.png`
- `/tmp/runforge-admin-ui-3-visual/runs-filtered.png`
- `/tmp/runforge-admin-ui-3-visual/detail-final-2.png`
- `/tmp/runforge-admin-ui-3-visual/compare.png`
- `/tmp/runforge-admin-ui-3-visual/settings.png`
- `/tmp/runforge-admin-ui-3-visual/artifact-copy.png`

## Issues Found And Fixed

- The runs table originally widened the whole page to about 2400px because long artifact paths stretched the layout. Fixed by constraining page sections and making the runs table scroll internally.
- The run-detail table link handler used a fragile selector for long ids. Fixed by using exact `data-detail-id` comparison and retaining native `<summary>` expansion.
- Artifact open links initially routed `/tmp` packet artifacts through `/api/admin/artifact`, which correctly rejects paths outside configured run roots. Fixed by only using the safe artifact route for allowed run-root paths and falling back to `file://` for other absolute paths.

## Checks Observed

- Page width stayed at 1280px after layout fix; only the runs table had horizontal overflow.
- Search filter reduced visible runs from 7 to 4 for `provider`.
- Detail expansion showed one open detail, 51 timeline nodes, 32 artifact controls, and collapsed JSON sections.
- Compare view rendered 16 fields and highlighted 13 changed fields for the selected pair.
- Settings view showed 2 repository rows, 2 provider rows, 2 run-root rows, diagnostics, and enabled localhost save.
- Artifact copy button changed to `copied`.
- No raw provider token values were observed in rendered UI.

## Unresolved UI Limitations

- Desktop is usable, but the run table remains intentionally wide and scrolls horizontally because it exposes many operator fields and paths.
- Browser `file://` opening remains browser-policy dependent; the UI always provides visible absolute paths and copy buttons.
- Compare is field-based and lightweight; it does not render a semantic diff of packet contents.
