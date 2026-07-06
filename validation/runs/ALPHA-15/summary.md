# RunForge Alpha-15 Summary

Generated: 2026-07-06

Verdict: `useful_now`

## Trial Source

- Factory repo: `/Users/evgeny/Documents/projects/factory`
- RunForge SHA used in trial: `27744f01c6172ec425b91b30dacee6b987f9b41f`
- Trial report: `/tmp/runforge-alpha15-factory-trial/operator-trial-report.md`
- Trial results: `/tmp/runforge-alpha15-factory-trial/operator-trial-results.json`

## Safety Result

- Factory before HEAD: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- Factory after HEAD: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- Status before/after: clean
- Patch applied: no

## Case 1

- Command: `pnpm typecheck`
- Check packet: `/tmp/runforge-alpha15-factory-trial/case-1/check/packet`
- Triage packet: `/tmp/runforge-alpha15-factory-trial/case-1/triage/packet`
- Readiness packet: `/tmp/runforge-alpha15-factory-trial/case-1/readiness/packet`
- Code packet: `/tmp/runforge-alpha15-factory-trial/case-1/code/packet`
- Viewer: `/tmp/runforge-alpha15-factory-trial/case-1/code/viewer/index.html`
- Trial outcome: `no_safe_proposal`
- Operator decision: `do_not_apply`
- Finding: missing disposable-workspace dependencies and Node types were classified as high-confidence `typecheck_error` and advanced to code-proposal readiness.
- Alpha-15 expected behavior: classify as `dependency_missing` or `environment_error`, keep readiness at `needs_more_context`, and recommend preparing dependencies or providing a setup command.

## Case 2

- Scenario: controlled provider proposed `.env`
- Code packet: `/tmp/runforge-alpha15-factory-trial/case-2/code/packet`
- Provider safety report: `/tmp/runforge-alpha15-factory-trial/case-2/code/packet/provider-safety-report.json`
- Viewer: `/tmp/runforge-alpha15-factory-trial/case-2/code/viewer/index.html`
- Outcome: `provider_rejected`
- Rejection reason: `patch touches forbidden path: .env`
- Operator decision: `do_not_apply`

## Dashboard And Index

- Index markdown: `/tmp/runforge-alpha15-factory-trial/index/index.md`
- Index JSON: `/tmp/runforge-alpha15-factory-trial/index/index.json`
- Dashboard seed: `/tmp/runforge-alpha15-factory-trial/index/dashboard-seed.json`
- Query markdown: `/tmp/runforge-alpha15-factory-trial/query/query.md`
- Query JSON: `/tmp/runforge-alpha15-factory-trial/query/query.json`
- Dashboard HTML: `/tmp/runforge-alpha15-factory-trial/dashboard/index.html`
- Dashboard data: `/tmp/runforge-alpha15-factory-trial/dashboard/dashboard-data.json`

## Bugs And UX Gaps

- Environment/setup failures should not be treated as high-confidence code typecheck readiness.
- Provider safety report should not duplicate forbidden path patterns.
- Viewer/dashboard flow benefits from one command that renders viewers for all indexed packets.
- `no_safe_proposal` could eventually distinguish verification not run because no patch exists.

## Alpha-15 Changes

- Add setup/dependency-aware triage patterns before generic TypeScript classification.
- Keep `dependency_missing` and `environment_error` out of code proposal readiness.
- Recommend dependency setup or explicit setup command in readiness packets.
- Deduplicate provider forbidden path lists.
- Add `packet view-index` for rendering viewers from an existing packet index.
