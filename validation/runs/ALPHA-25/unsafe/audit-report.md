# Operator Handoff Replay Audit

Audit ID: alpha25-unsafe-handoff-rejected
Status: failed
Handoff path: /tmp/runforge-alpha25-handoff-replay/factory/unsafe-handoff

Replay applies only in a disposable replay worktree.
Original repo is never modified.
Replay is an audit/simulation, not production apply.

## Source Repo

- Path: /Users/evgeny/Documents/projects/factory
- HEAD before: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- HEAD after: d65ab9a9c8130f5d2c9214e8fdde2a278578afed
- Status before: (clean)
- Status after: (clean)
- Original repo mutated: false

## Replay

- Worktree: /tmp/runforge-alpha25-handoff-replay/factory/unsafe-audit/replay-worktree
- Patch applied: false
- Validation run: false
- Validation status: skipped

## Decision Forms

- Accepted valid: true
- Rejected valid: true

## Findings

- handoff packet missing README.md
- handoff.json proposal.autoAppliedByRunForge must be false
- validation command attempts forbidden push operation

## Recommendations

- Do not trust this handoff until the patch applies cleanly in a disposable replay worktree.
- Do not accept this handoff until declared validation passes after replay apply.
