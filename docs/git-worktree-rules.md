# Git and worktree rules for agentic development

RunForge must follow the same operational discipline it recommends. Agent work should happen in isolated git state, with explicit provenance before and after every task.

## Core rules

1. One task = one branch/worktree.
   - Create a dedicated branch for each agent task.
   - Prefer a separate worktree for non-trivial work, especially when another task is already in progress.

2. Do not do non-trivial agent work directly on `main`.
   - `main` is for reviewed, merged, or intentionally maintained state.
   - Tiny read-only inspections are fine. Edits, generated artifacts, test updates, and commits need a task branch.

3. Inspect git status and base commit before work.
   - Record the current branch, status, and `HEAD` before editing.
   - If the starting worktree is dirty, identify which changes are pre-existing.

4. Never commit unrelated dirty changes.
   - Treat pre-existing dirty files as user-owned unless the task explicitly includes them.
   - If a required file is already dirty, inspect it carefully and preserve unrelated edits.

5. Never use `git add .` blindly when the repo was dirty.
   - Stage explicit paths.
   - Use `git diff --staged` before committing.

6. No destructive git operations without explicit approval.
   - Do not run `git reset --hard`, `git clean -fd`, or force push unless the user explicitly approves the exact action and scope.

7. Make atomic commits.
   - Each commit should represent one coherent change.
   - Keep generated artifacts, docs, tests, and source changes together only when they are part of the same behavior.

8. Final reports must include git evidence.
   - Current git status.
   - Diff summary.
   - Checks run.
   - Commit hash, if a commit was created.

9. Clean up worktrees only after merge or confirmation.
   - Do not remove a task worktree while its branch, PR, review, or handoff is still active.
   - After merge or explicit confirmation, remove the worktree and delete the task branch if appropriate.

## Starting a new agent task

From the main RunForge checkout:

```bash
git status --short --branch
git rev-parse HEAD
mkdir -p ../RunForge-worktrees
git worktree add -b codex/RUNFORGE-TASK-ID ../RunForge-worktrees/runforge-task-id HEAD
cd ../RunForge-worktrees/runforge-task-id
git status --short --branch
```

Replace `RUNFORGE-TASK-ID` with the task name. If the main worktree is dirty, still create the task worktree from the recorded base commit or from `HEAD`, then leave the dirty main worktree untouched.

## Handing off a task

Before final handoff:

```bash
git status --short --branch
git diff --stat
pnpm check:git-safety
```

Also run the task-appropriate checks, usually `pnpm dogfood` for RunForge changes. If a commit exists, include:

```bash
git rev-parse HEAD
```
