# Validation Instructions

Run validation only inside the disposable/operator worktree.

Before applying the patch, the command is expected to fail because this handoff exists for a failed trial.

```bash
cd '/tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree'
node runforge-alpha22-verify.cjs
```

After manually applying `proposal.patch`, rerun the same command. Expected result for acceptance: command exits successfully.

Evidence should be recorded through the existing external record-decision flow and linked from the proposal packet, operator summary, lifecycle report, packet index, and dashboard seed.
