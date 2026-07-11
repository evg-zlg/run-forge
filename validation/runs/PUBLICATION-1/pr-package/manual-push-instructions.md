# Manual Push Instructions

After owner review only:

1. Inspect and commit the prepared change: `git -C /Users/evgeny/Documents/projects/RunForge/validation/runs/PUBLICATION-1/local-branch-worktree diff && git -C /Users/evgeny/Documents/projects/RunForge/validation/runs/PUBLICATION-1/local-branch-worktree add README.md && git -C /Users/evgeny/Documents/projects/RunForge/validation/runs/PUBLICATION-1/local-branch-worktree commit -m "Document offline validation workflow"`.
2. Publish separately: `git -C /Users/evgeny/Documents/projects/RunForge/validation/runs/PUBLICATION-1/local-branch-worktree push -u origin runforge/publication-1-demo`.

RunForge executed neither commit nor push.
