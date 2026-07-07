# RunForge Alpha-21 Operator Accepted Patch Trial

Generated at: 2026-07-07T05:46:41.586Z
Trial root: /tmp/runforge-alpha21-operator-trial

## Outcome

Final verdict: passed

## Evidence

- Proposal packet: /tmp/runforge-alpha21-operator-trial/proposal-run/packet
- Proposal patch: /tmp/runforge-alpha21-operator-trial/proposal-run/packet/proposal.patch
- Operator decision: /tmp/runforge-alpha21-operator-trial/proposal-run/packet/operator-decision.json
- Operator validation packet: /tmp/runforge-alpha21-operator-trial/decision/validation-rerun/packet
- Packet viewer: /tmp/runforge-alpha21-operator-trial/viewer/index.html
- Dashboard: /tmp/runforge-alpha21-operator-trial/dashboard/index.html
- Lifecycle report: /Users/evgeny/Documents/projects/RunForge/validation/runs/ALPHA-21/lifecycle-report.json

## Safety Checks

- RunForge generated a proposal-only patch.
- The validation script manually applied proposal.patch only in a disposable operator worktree.
- RunForge record-decision reran validation and recorded `accepted` without applying the patch.
- The original controlled source repo remained unchanged.
- No provider, network, DB, push, merge, or deploy was required.

## Commands Run

- pnpm dev external patch-trial --root /tmp/runforge-alpha21-operator-trial --out /tmp/runforge-alpha21-operator-trial/proposal-run --run-id alpha21-operator-patch-trial
- # stdout: Patch trial source: /tmp/runforge-alpha21-operator-trial/source
- # stderr: $ tsx src/cli/index.ts external patch-trial --root /tmp/runforge-alpha21-operator-trial --out /tmp/runforge-alpha21-operator-trial/proposal-run --run-id alpha21-operator-patch-trial
- (cd /tmp/runforge-alpha21-operator-trial/source && node verify.js)
- (cd /tmp/runforge-alpha21-operator-trial/operator-worktree && git apply /tmp/runforge-alpha21-operator-trial/proposal-run/packet/proposal.patch)
- (cd /tmp/runforge-alpha21-operator-trial/operator-worktree && node verify.js)
- pnpm dev external record-decision --proposal-packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --repo /tmp/runforge-alpha21-operator-trial/operator-worktree --command node verify.js --decision accepted --out /tmp/runforge-alpha21-operator-trial/decision --run-id alpha21-operator-accepted --notes Alpha-21 validation manually applied proposal.patch in a disposable operator worktree.
- # stdout: Operator decision recorded: accepted
- # stderr: $ tsx src/cli/index.ts external record-decision --proposal-packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --repo /tmp/runforge-alpha21-operator-trial/operator-worktree --command 'node verify.js' --decision accepted --out /tmp/runforge-alpha21-operator-trial/decision --run-id alpha21-operator-accepted --notes 'Alpha-21 validation manually applied proposal.patch in a disposable operator worktree.'
- pnpm dev packet inspect --packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --validate
- # stdout: Run ID: alpha21-operator-patch-trial
- # stderr: $ tsx src/cli/index.ts packet inspect --packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --validate
- pnpm dev packet view --packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --out /tmp/runforge-alpha21-operator-trial/viewer
- # stdout: Packet viewer written: /tmp/runforge-alpha21-operator-trial/viewer/index.html
- # stderr: $ tsx src/cli/index.ts packet view --packet /tmp/runforge-alpha21-operator-trial/proposal-run/packet --out /tmp/runforge-alpha21-operator-trial/viewer
- (cd /tmp/runforge-alpha21-operator-trial/source && git status --short)
- (cd /tmp/runforge-alpha21-operator-trial/source && git rev-parse HEAD)
- (cd /tmp/runforge-alpha21-operator-trial/source && git rev-parse HEAD)
- pnpm dev packet index --root ./validation/runs --out /tmp/runforge-alpha21-operator-trial/index --dashboard-seed
- # stdout: Indexed 11 packet/run entries under /Users/evgeny/Documents/projects/RunForge/validation/runs.
- # stderr: $ tsx src/cli/index.ts packet index --root ./validation/runs --out /tmp/runforge-alpha21-operator-trial/index --dashboard-seed
- pnpm dev dashboard build --seed /tmp/runforge-alpha21-operator-trial/index/dashboard-seed.json --out /tmp/runforge-alpha21-operator-trial/dashboard
- # stdout: Dashboard written: /tmp/runforge-alpha21-operator-trial/dashboard/index.html
- # stderr: $ tsx src/cli/index.ts dashboard build --seed /tmp/runforge-alpha21-operator-trial/index/dashboard-seed.json --out /tmp/runforge-alpha21-operator-trial/dashboard

## Errors

- none
