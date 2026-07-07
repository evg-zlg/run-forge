# Manual Apply Instructions

RunForge proposes only. Operator applies manually. Original repo must remain unchanged.

Use only the designated disposable/operator worktree:

```bash
cd '/tmp/runforge-alpha24-operator-handoff/factory/operator-accepted-worktree'
git status --short
git apply '../handoff/proposal.patch'
node runforge-alpha22-verify.cjs
```

Record the accepted decision only after the validation command passes, using `decision-form.accepted.json` as the template.
Record the rejected decision with `decision-form.rejected.json` if the operator declines the proposal or validation does not pass.
