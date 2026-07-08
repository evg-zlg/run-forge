# RunForge Alpha-24 Real Operator Handoff Packet

Generated at: 2026-07-08T17:30:38.839Z
Trial root: /tmp/runforge-alpha24-operator-handoff/factory

## Outcome

Final verdict: passed

## Real External Repo

- Source: /Users/evgeny/Documents/projects/factory
- HEAD before: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status before: (clean)
- HEAD after: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status after: (clean)
- Mutation verdict: unchanged

## Handoff Packet

- README: /tmp/runforge-alpha24-operator-handoff/factory/handoff/README.md
- JSON: /tmp/runforge-alpha24-operator-handoff/factory/handoff/handoff.json
- Apply instructions: /tmp/runforge-alpha24-operator-handoff/factory/handoff/apply-instructions.md
- Validation instructions: /tmp/runforge-alpha24-operator-handoff/factory/handoff/validation.md
- Rollback instructions: /tmp/runforge-alpha24-operator-handoff/factory/handoff/rollback.md
- Accepted decision form: /tmp/runforge-alpha24-operator-handoff/factory/handoff/decision-form.accepted.json
- Rejected decision form: /tmp/runforge-alpha24-operator-handoff/factory/handoff/decision-form.rejected.json

## Visibility

- packet index exposes handoff README path.
- dashboard data exposes handoff README and JSON paths.
- packet viewer exposes the operator handoff section.
- lifecycle-report.json counts generated handoff packets.

## Safety

- Original external repo HEAD/status unchanged.
- Manual apply instructions target only the disposable/operator worktree.
- No provider, network, DB, push, merge, or deploy was required.
- Handoff validation rejected unsafe or incomplete packets in unit coverage.

## Commands Run

- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha24-operator-handoff/factory --run-id alpha24-operator-handoff
- # stdout: Patch trial source: /tmp/runforge-alpha24-operator-handoff/factory/source-copy
- # stderr: $ tsx src/cli/index.ts external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha24-operator-handoff/factory --run-id alpha24-operator-handoff
- (cd /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree && git apply /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet/proposal.patch)
- (cd /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree && node runforge-alpha22-verify.cjs)
- pnpm dev external handoff-packet --trial /tmp/runforge-alpha24-operator-handoff/factory --out /tmp/runforge-alpha24-operator-handoff/factory/handoff --operator-worktree /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree --validation-command node runforge-alpha22-verify.cjs --trial-id alpha24-operator-handoff
- # stdout: Operator handoff packet: /tmp/runforge-alpha24-operator-handoff/factory/handoff
- # stderr: $ tsx src/cli/index.ts external handoff-packet --trial /tmp/runforge-alpha24-operator-handoff/factory --out /tmp/runforge-alpha24-operator-handoff/factory/handoff --operator-worktree /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree --validation-command 'node runforge-alpha22-verify.cjs' --trial-id alpha24-operator-handoff
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --repo /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree --command node runforge-alpha22-verify.cjs --decision accepted --out /tmp/runforge-alpha24-operator-handoff/factory/accepted-decision --run-id alpha24-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_manual --applied-to disposable_copy --notes Alpha-24 accepted evidence used the handoff decision template and disposable operator worktree.
- # stdout: Operator decision recorded: accepted
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --repo /tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree --command 'node runforge-alpha22-verify.cjs' --decision accepted --out /tmp/runforge-alpha24-operator-handoff/factory/accepted-decision --run-id alpha24-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_manual --applied-to disposable_copy --notes 'Alpha-24 accepted evidence used the handoff decision template and disposable operator worktree.'
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --repo /tmp/runforge-alpha24-operator-handoff/factory/operator-rejected-worktree --command node runforge-alpha22-verify.cjs --decision rejected --out /tmp/runforge-alpha24-operator-handoff/factory/rejected-decision --run-id alpha24-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes Alpha-24 rejected evidence declined the handoff proposal and left the disposable worktree failing.
- # stdout: Operator decision recorded: rejected
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --repo /tmp/runforge-alpha24-operator-handoff/factory/operator-rejected-worktree --command 'node runforge-alpha22-verify.cjs' --decision rejected --out /tmp/runforge-alpha24-operator-handoff/factory/rejected-decision --run-id alpha24-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes 'Alpha-24 rejected evidence declined the handoff proposal and left the disposable worktree failing.'
- pnpm dev packet inspect --packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --validate
- # stdout: Run ID: alpha24-operator-handoff
- # stderr: $ tsx src/cli/index.ts packet inspect --packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --validate
- pnpm dev packet view --packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --out /tmp/runforge-alpha24-operator-handoff/factory/viewer
- # stdout: Packet viewer written: /tmp/runforge-alpha24-operator-handoff/factory/viewer/index.html
- # stderr: $ tsx src/cli/index.ts packet view --packet /tmp/runforge-alpha24-operator-handoff/factory/proposal-run/packet --out /tmp/runforge-alpha24-operator-handoff/factory/viewer
- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev packet index --root ./validation/runs --out /tmp/runforge-alpha24-operator-handoff/factory/index --dashboard-seed
- # stdout: Indexed 14 packet/run entries under /Users/evgeny/Documents/projects/RunForge/validation/runs.
- # stderr: $ tsx src/cli/index.ts packet index --root ./validation/runs --out /tmp/runforge-alpha24-operator-handoff/factory/index --dashboard-seed
- pnpm dev dashboard build --seed /tmp/runforge-alpha24-operator-handoff/factory/index/dashboard-seed.json --out /tmp/runforge-alpha24-operator-handoff/factory/dashboard
- # stdout: Dashboard written: /tmp/runforge-alpha24-operator-handoff/factory/dashboard/index.html
- # stderr: $ tsx src/cli/index.ts dashboard build --seed /tmp/runforge-alpha24-operator-handoff/factory/index/dashboard-seed.json --out /tmp/runforge-alpha24-operator-handoff/factory/dashboard

## Errors

- none

## Limitations

- The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.
- Alpha-24 creates an operator handoff bundle; it still does not auto-apply to protected repositories.
