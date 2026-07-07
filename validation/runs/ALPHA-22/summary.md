# RunForge Alpha-22 Real External Repo Operator Trial

Generated at: 2026-07-07T05:46:53.457Z
Trial root: /tmp/runforge-alpha22-real-repo-trial/factory

## Outcome

Final verdict: passed

## Real External Repo

- Source: /Users/evgeny/Documents/projects/factory
- HEAD before: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status before: (clean)
- HEAD after: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status after: (clean)
- Mutation verdict: unchanged

## Evidence

- Disposable source copy: /tmp/runforge-alpha22-real-repo-trial/factory/source-copy
- Accepted operator worktree: /tmp/runforge-alpha22-real-repo-trial/factory/operator-accepted-worktree
- Rejected operator worktree: /tmp/runforge-alpha22-real-repo-trial/factory/operator-rejected-worktree
- Proposal packet: /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet
- Proposal patch: /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet/proposal.patch
- Accepted decision: /tmp/runforge-alpha22-real-repo-trial/factory/accepted-decision/operator-decision.json
- Rejected decision: /tmp/runforge-alpha22-real-repo-trial/factory/rejected-decision/operator-decision.json
- Packet viewer: /tmp/runforge-alpha22-real-repo-trial/factory/viewer/index.html
- Dashboard: /tmp/runforge-alpha22-real-repo-trial/factory/dashboard/index.html
- Lifecycle report: /Users/evgeny/Documents/projects/RunForge/validation/runs/ALPHA-22/lifecycle-report.json

## Decisions

- Accepted path: proposal generated, operator_simulated_manual_apply in disposable_copy, validation passed, originalRepoMutated false.
- Rejected path: proposal generated, operator_declined in disposable_copy, validation remained failed, originalRepoMutated false.

## Visibility

- results.json records accepted and rejected attempts separately.
- dashboard seed/dashboard data expose accepted and rejected operator verdicts.
- lifecycle-report.json includes Alpha-22 milestone comparison.

## Safety Checks

- Failure was injected only into the disposable real-repo copy.
- The original Factory repo HEAD/status was recorded before and after and remained unchanged.
- No provider, network, DB, push, merge, or deploy was required.
- RunForge generated and recorded packets; it did not apply a patch to the original external repo.

## Commands Run

- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha22-real-repo-trial/factory --run-id alpha22-real-repo-operator-trial
- # stdout: Patch trial source: /tmp/runforge-alpha22-real-repo-trial/factory/source-copy
- # stderr: $ tsx src/cli/index.ts external patch-trial --repo /Users/evgeny/Documents/projects/factory --mode real-repo-disposable --out /tmp/runforge-alpha22-real-repo-trial/factory --run-id alpha22-real-repo-operator-trial
- (cd /tmp/runforge-alpha22-real-repo-trial/factory/source-copy && node runforge-alpha22-verify.cjs)
- (cd /tmp/runforge-alpha22-real-repo-trial/factory/operator-accepted-worktree && git apply /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet/proposal.patch)
- (cd /tmp/runforge-alpha22-real-repo-trial/factory/operator-accepted-worktree && node runforge-alpha22-verify.cjs)
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --repo /tmp/runforge-alpha22-real-repo-trial/factory/operator-accepted-worktree --command node runforge-alpha22-verify.cjs --decision accepted --out /tmp/runforge-alpha22-real-repo-trial/factory/accepted-decision --run-id alpha22-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_simulated_manual_apply --applied-to disposable_copy --notes Alpha-22 manually applied proposal.patch only in the disposable accepted operator worktree.
- # stdout: Operator decision recorded: accepted
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --repo /tmp/runforge-alpha22-real-repo-trial/factory/operator-accepted-worktree --command 'node runforge-alpha22-verify.cjs' --decision accepted --out /tmp/runforge-alpha22-real-repo-trial/factory/accepted-decision --run-id alpha22-operator-accepted --reason validation_passed_after_operator_apply --apply-mode operator_simulated_manual_apply --applied-to disposable_copy --notes 'Alpha-22 manually applied proposal.patch only in the disposable accepted operator worktree.'
- (cd /tmp/runforge-alpha22-real-repo-trial/factory/operator-rejected-worktree && node runforge-alpha22-verify.cjs)
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --repo /tmp/runforge-alpha22-real-repo-trial/factory/operator-rejected-worktree --command node runforge-alpha22-verify.cjs --decision rejected --out /tmp/runforge-alpha22-real-repo-trial/factory/rejected-decision --run-id alpha22-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes Alpha-22 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree.
- # stdout: Operator decision recorded: rejected
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --repo /tmp/runforge-alpha22-real-repo-trial/factory/operator-rejected-worktree --command 'node runforge-alpha22-verify.cjs' --decision rejected --out /tmp/runforge-alpha22-real-repo-trial/factory/rejected-decision --run-id alpha22-operator-rejected --reason operator_declined --apply-mode operator_declined --applied-to disposable_copy --notes 'Alpha-22 rejection path intentionally did not apply proposal.patch; validation remains failed only in the disposable rejected worktree.'
- pnpm dev packet inspect --packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --validate
- # stdout: Run ID: alpha22-real-repo-operator-trial
- # stderr: $ tsx src/cli/index.ts packet inspect --packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --validate
- pnpm dev packet view --packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --out /tmp/runforge-alpha22-real-repo-trial/factory/viewer
- # stdout: Packet viewer written: /tmp/runforge-alpha22-real-repo-trial/factory/viewer/index.html
- # stderr: $ tsx src/cli/index.ts packet view --packet /tmp/runforge-alpha22-real-repo-trial/factory/proposal-run/packet --out /tmp/runforge-alpha22-real-repo-trial/factory/viewer
- (cd /Users/evgeny/Documents/projects/factory && git rev-parse HEAD)
- (cd /Users/evgeny/Documents/projects/factory && git status --short)
- pnpm dev packet index --root ./validation/runs --out /tmp/runforge-alpha22-real-repo-trial/factory/index --dashboard-seed
- # stdout: Indexed 11 packet/run entries under /Users/evgeny/Documents/projects/RunForge/validation/runs.
- # stderr: $ tsx src/cli/index.ts packet index --root ./validation/runs --out /tmp/runforge-alpha22-real-repo-trial/factory/index --dashboard-seed
- pnpm dev dashboard build --seed /tmp/runforge-alpha22-real-repo-trial/factory/index/dashboard-seed.json --out /tmp/runforge-alpha22-real-repo-trial/factory/dashboard
- # stdout: Dashboard written: /tmp/runforge-alpha22-real-repo-trial/factory/dashboard/index.html
- # stderr: $ tsx src/cli/index.ts dashboard build --seed /tmp/runforge-alpha22-real-repo-trial/factory/index/dashboard-seed.json --out /tmp/runforge-alpha22-real-repo-trial/factory/dashboard

## Errors

- none

## Limitations

- The real repo source was Factory, but the failure was intentionally injected only into the disposable copy.
- Alpha-22 still records operator decisions; it does not authorize auto-apply to protected repositories.
