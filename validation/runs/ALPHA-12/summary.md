# RunForge Alpha-12 Validation

Generated at: 2026-07-06T07:20:11.344Z

## Black-box Outputs

- index: /tmp/runforge-alpha12-index
- dashboard: /tmp/runforge-alpha12-dashboard

## Checks

- Dashboard schemaVersion: alpha-12-dashboard
- Dashboard records: 6
- Latest alpha: ALPHA-10
- Verified proposals: 3
- Provider rejections: 3
- Original repos unchanged: true
- HTML includes summary: true
- HTML includes records: true
- Missing seed exit code: 1
- Invalid seed exit code: 1

## Commands

- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet index --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha12-index --dashboard-seed
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev dashboard build --seed /tmp/runforge-alpha12-index/dashboard-seed.json --out /tmp/runforge-alpha12-dashboard
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev dashboard build --seed /tmp/runforge-alpha12-missing-seed.json --out /tmp/runforge-alpha12-missing-dashboard
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev dashboard build --seed /tmp/runforge-alpha12-invalid-seed.json --out /tmp/runforge-alpha12-invalid-dashboard

Alpha-12 validation: passed
