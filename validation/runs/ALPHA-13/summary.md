# RunForge Alpha-13 Validation

Generated at: 2026-07-06T16:50:05.156Z

## Dashboard Outputs

- dashboard build path: /tmp/runforge-alpha13-dashboard
- index path: /tmp/runforge-alpha13-index
- dashboard HTML path: /tmp/runforge-alpha13-dashboard/index.html
- dashboard data path: /tmp/runforge-alpha13-dashboard/dashboard-data.json

## Checks

- Dashboard schemaVersion: alpha-12-dashboard
- Dashboard data record count: 6
- Filters tested: text search, outcome, repo, provider status, mutation verdict, alpha/milestone
- Expected records found: proposal_ready_verified, provider_rejected, smartsql, mutation:unchanged
- No backend required: true
- Static dashboard works from generated files: true
- Local links/path display verified in generated HTML: true
- Search input: true
- Outcome filter: true
- Repo filter: true
- Provider status filter: true
- Mutation verdict filter: true
- Alpha/milestone filter: true
- Reset filters button: true
- Details drilldown: true
- Safety labels: true
- No external network dependencies: true
- Seed count matches dashboard data: true

## Commands

- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet index --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha13-index --dashboard-seed
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev dashboard build --seed /tmp/runforge-alpha13-index/dashboard-seed.json --out /tmp/runforge-alpha13-dashboard

Alpha-13 validation: passed
