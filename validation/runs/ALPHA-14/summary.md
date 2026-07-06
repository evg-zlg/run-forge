# RunForge Alpha-14 Validation

Generated at: 2026-07-06T16:50:05.237Z

## Dashboard Outputs

- dashboard build path: /tmp/runforge-alpha14-dashboard
- index path: /tmp/runforge-alpha14-index
- dashboard HTML path: /tmp/runforge-alpha14-dashboard/index.html
- dashboard data path: /tmp/runforge-alpha14-dashboard/dashboard-data.json

## Checks

- Dashboard schemaVersion: alpha-12-dashboard
- Dashboard data record count: 6
- Filters restored from hash/query: true
- Filter changes update URL state: true
- Reset clears URL/filter state: true
- Copy current view affordance: true
- Grouped repo counts checked: true
- Grouped scenario counts checked: true
- Grouped outcome counts checked: true
- Grouped alpha counts checked: true
- Alpha comparison checked: true
- Derived counters checked: true
- Quick verified filter checked: true
- Quick unsafe/do_not_apply filter checked: true
- Sortable records table: true
- Empty state: true
- No backend required: true
- No external network dependencies: true
- Seed count matches dashboard data: true

## Commands

- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet index --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha14-index --dashboard-seed
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev dashboard build --seed /tmp/runforge-alpha14-index/dashboard-seed.json --out /tmp/runforge-alpha14-dashboard

Alpha-14 validation: passed
