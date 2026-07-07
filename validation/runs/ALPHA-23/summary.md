# RunForge Alpha-23 Operator Patch Trial UX Hardening

Generated at: 2026-07-07T05:47:04.599Z
Trial root: /tmp/runforge-alpha23-operator-patch-ux/factory

## Outcome

Final verdict: passed

## Real External Repo

- Source: /Users/evgeny/Documents/projects/factory
- HEAD before: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status before: (clean)
- HEAD after: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status after: (clean)
- Mutation verdict: unchanged

## Operator UX Evidence

- Operator summary: /Users/evgeny/Documents/projects/RunForge/validation/runs/ALPHA-23/operator-summary.md
- Accepted decision: /tmp/runforge-alpha23-operator-patch-ux/factory/accepted-decision/accepted-operator-decision.json
- Rejected decision: /tmp/runforge-alpha23-operator-patch-ux/factory/rejected-decision/operator-decision.json
- Accepted decision summary: /tmp/runforge-alpha23-operator-patch-ux/factory/accepted-decision/operator-summary.md
- Rejected decision summary: /tmp/runforge-alpha23-operator-patch-ux/factory/rejected-decision/operator-summary.md
- Packet viewer: /tmp/runforge-alpha23-operator-patch-ux/factory/viewer/index.html
- Dashboard: /tmp/runforge-alpha23-operator-patch-ux/factory/dashboard/index.html
- Lifecycle report: /Users/evgeny/Documents/projects/RunForge/validation/runs/ALPHA-23/lifecycle-report.json

## Decisions

- Accepted path: workflow succeeded, operator_simulated_manual_apply in disposable_copy, validation failed->passed, originalRepoMutated false.
- Rejected path: workflow succeeded, operator_declined in disposable_copy, validation failed->failed, originalRepoMutated false.

## Visibility

- packet index exposes decision verdict, before/after validation, applied target, auto-apply false, mutation verdict, and patch path.
- dashboard data exposes accepted/rejected operator verdicts, validation transitions, mutation verdict, and patch path.
- lifecycle-report.json counts accepted/rejected/missing/unsafe operator trials.
- packet viewer exposes the operator decision and summary.

## Safety Lint

- accepted_original_mutation: rejected
- accepted_missing_after_validation: rejected
- accepted_failed_after_validation: rejected
- rejected_without_reason: rejected
- missing_auto_apply_false: rejected
- missing_applied_to: rejected
- applied_to_original_repo: rejected
- missing_packet_link: rejected
- missing_safety_summary: rejected

## Commands Run

- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha23-operator-patch-ux/factory --run-id alpha23-operator-patch-ux
- # stdout: Patch trial source: /tmp/runforge-alpha23-operator-patch-ux/factory/source-copy
- # stderr: $ tsx src/cli/index.ts external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha23-operator-patch-ux/factory --run-id alpha23-operator-patch-ux
- (cd /tmp/runforge-alpha23-operator-patch-ux/factory/source-copy && node runforge-alpha22-verify.cjs)
- (cd /tmp/runforge-alpha23-operator-patch-ux/factory/operator-accepted-worktree && git apply /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet/proposal.patch)
- (cd /tmp/runforge-alpha23-operator-patch-ux/factory/operator-accepted-worktree && node runforge-alpha22-verify.cjs)
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --repo /tmp/runforge-alpha23-operator-patch-ux/factory/operator-accepted-worktree --command node runforge-alpha22-verify.cjs --decision accepted --out /tmp/runforge-alpha23-operator-patch-ux/factory/accepted-decision --run-id alpha23-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_simulated_manual_apply --applied-to disposable_copy --notes Alpha-23 accepted path manually applied proposal.patch only in the disposable accepted operator worktree.
- # stdout: Operator decision recorded: accepted
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --repo /tmp/runforge-alpha23-operator-patch-ux/factory/operator-accepted-worktree --command 'node runforge-alpha22-verify.cjs' --decision accepted --out /tmp/runforge-alpha23-operator-patch-ux/factory/accepted-decision --run-id alpha23-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_simulated_manual_apply --applied-to disposable_copy --notes 'Alpha-23 accepted path manually applied proposal.patch only in the disposable accepted operator worktree.'
- (cd /tmp/runforge-alpha23-operator-patch-ux/factory/operator-rejected-worktree && node runforge-alpha22-verify.cjs)
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --repo /tmp/runforge-alpha23-operator-patch-ux/factory/operator-rejected-worktree --command node runforge-alpha22-verify.cjs --decision rejected --out /tmp/runforge-alpha23-operator-patch-ux/factory/rejected-decision --run-id alpha23-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes Alpha-23 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree.
- # stdout: Operator decision recorded: rejected
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --repo /tmp/runforge-alpha23-operator-patch-ux/factory/operator-rejected-worktree --command 'node runforge-alpha22-verify.cjs' --decision rejected --out /tmp/runforge-alpha23-operator-patch-ux/factory/rejected-decision --run-id alpha23-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes 'Alpha-23 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree.'
- pnpm dev packet inspect --packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --validate
- # stdout: Run ID: alpha23-operator-patch-ux
- # stderr: $ tsx src/cli/index.ts packet inspect --packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --validate
- pnpm dev packet view --packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --out /tmp/runforge-alpha23-operator-patch-ux/factory/viewer
- # stdout: Packet viewer written: /tmp/runforge-alpha23-operator-patch-ux/factory/viewer/index.html
- # stderr: $ tsx src/cli/index.ts packet view --packet /tmp/runforge-alpha23-operator-patch-ux/factory/proposal-run/packet --out /tmp/runforge-alpha23-operator-patch-ux/factory/viewer
- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev packet index --root ./validation/runs --out /tmp/runforge-alpha23-operator-patch-ux/factory/index --dashboard-seed
- # stdout: Indexed 11 packet/run entries under /Users/evgeny/Documents/projects/RunForge/validation/runs.
- # stderr: $ tsx src/cli/index.ts packet index --root ./validation/runs --out /tmp/runforge-alpha23-operator-patch-ux/factory/index --dashboard-seed
- pnpm dev dashboard build --seed /tmp/runforge-alpha23-operator-patch-ux/factory/index/dashboard-seed.json --out /tmp/runforge-alpha23-operator-patch-ux/factory/dashboard
- # stdout: Dashboard written: /tmp/runforge-alpha23-operator-patch-ux/factory/dashboard/index.html
- # stderr: $ tsx src/cli/index.ts dashboard build --seed /tmp/runforge-alpha23-operator-patch-ux/factory/index/dashboard-seed.json --out /tmp/runforge-alpha23-operator-patch-ux/factory/dashboard

## Errors

- none

## Limitations

- The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.
- Alpha-23 improves operator UX and safety lint; it still does not authorize auto-apply to protected repositories.
