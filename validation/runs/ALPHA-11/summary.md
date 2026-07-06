# RunForge Alpha-11 Validation

Generated at: 2026-07-06T16:49:55.024Z

## Black-box Outputs

- index: /tmp/runforge-alpha11-index
- queryReady: /tmp/runforge-alpha11-query-ready
- queryRejected: /tmp/runforge-alpha11-query-rejected
- queryRepo: /tmp/runforge-alpha11-query-repo
- queryMutation: /tmp/runforge-alpha11-query-mutation
- queryEmpty: /tmp/runforge-alpha11-query-empty
- latest: /tmp/runforge-alpha11-latest-report
- seed: /tmp/runforge-alpha11-dashboard-seed

## Checks

- Alpha-9/Alpha-10 proposal_ready_verified: 3
- Alpha-9/Alpha-10 provider_rejected: 3
- Alpha-9/Alpha-10 smartsql entries: 5
- Alpha-9/Alpha-10 unchanged mutation entries: 6
- Empty query matches: 0
- Invalid index exit code: 1
- Latest alpha: ALPHA-10
- Latest dogfood case count: 6
- Dashboard seed records: 6

## Commands

- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet index --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha11-index
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-index/index.json --out /tmp/runforge-alpha11-query-ready --outcome proposal_ready_verified
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-index/index.json --out /tmp/runforge-alpha11-query-rejected --outcome provider_rejected
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-index/index.json --out /tmp/runforge-alpha11-query-repo --repo smartsql
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-index/index.json --out /tmp/runforge-alpha11-query-mutation --mutation-verdict unchanged
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-index/index.json --out /tmp/runforge-alpha11-query-empty --scenario does-not-exist
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet report latest --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha11-latest-report
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet index --root /Users/evgeny/Documents/projects/RunForge/validation/runs --out /tmp/runforge-alpha11-dashboard-seed --dashboard-seed
- PASSED pnpm --dir /Users/evgeny/Documents/projects/RunForge dev packet query --index /tmp/runforge-alpha11-missing-index.json

Alpha-11 validation: passed

