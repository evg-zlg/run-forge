# RunForge Alpha-15 Operator Decisions

Generated: 2026-07-06

External trial: Factory using RunForge as an external operator tool.

Final verdict: `useful_now`

## Factory Safety

- Factory repo: `/Users/evgeny/Documents/projects/factory`
- Before HEAD: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- After HEAD: `d65ab9a9c8130f5d2c9214e8fdde2a278578afed`
- Status before: clean
- Status after: clean
- Patch applied: no

## Decisions

### Case 1

- Packet: `/tmp/runforge-alpha15-factory-trial/case-1/code/packet`
- Viewer: `/tmp/runforge-alpha15-factory-trial/case-1/code/viewer/index.html`
- Decision: reject
- Operator verdict: `do_not_apply`
- Reason: the failed `pnpm typecheck` evidence points to missing disposable-workspace dependencies and Node types, not a source-code defect.

### Case 2

- Packet: `/tmp/runforge-alpha15-factory-trial/case-2/code/packet`
- Viewer: `/tmp/runforge-alpha15-factory-trial/case-2/code/viewer/index.html`
- Decision: reject
- Operator verdict: `do_not_apply`
- Reason: the controlled provider attempted to touch `.env`, which RunForge rejected as a forbidden path.
