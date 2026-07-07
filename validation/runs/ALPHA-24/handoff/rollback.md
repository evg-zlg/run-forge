# Rollback Notes

Rollback is local to the disposable/operator worktree only. Original repo must remain unchanged.

```bash
cd '/tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree'
git apply -R '../handoff/proposal.patch'
git status --short
```

If rollback does not apply cleanly, discard the disposable/operator worktree and recreate it from the disposable source copy. Do not change the original repo as part of this handoff.
