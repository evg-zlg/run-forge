# RUNFORGE-ONBOARDING-1 validation

Date: 2026-07-16

## External dogfood

Target: `/Users/evgeny/Documents/projects/upravdom`

- Initial/final target SHA: `56c03b59f2e796a177785f9e19eea67a6e714827`
- Initial/final worktree: clean
- Discovery: `runforge onboarding --repo ... --format json`
- Readiness: `runforge doctor --repo ... --runtime docker --format json`
- Task intake: TaskSpec v2, read-only authority, explicit `node --version`
- Runtime: `runforge:local`, Docker task network disabled
- Result: `completed`; target `changed: false`; owner gate `not_required`
- Entry artifacts: `/tmp/runforge-onboarding-dogfood-1/results.json` and `summary.md`
- Target branch, commits, PRs, main, prod, DB, secrets, migrations, deploy: untouched

## New-session review defects found and corrected

1. macOS `/var` and `/private/var` aliases could bypass the output-inside-target check. All potentially missing paths are now canonicalized through their deepest existing ancestor.
2. A completed read-only run inherited an internal review owner gate and repair recommendation. TaskSpec result finalization now reports no owner gate and a completion-specific next action.
3. The normalized validation list originally omitted the target evidence command. It now includes target validation plus safety checks.
4. Artifact entry paths were long checkout-relative paths. Official TaskSpec entry paths are now stable root-relative names.
5. Onboarding required the session to infer a TaskSpec shape. Onboarding JSON now embeds a minimal TaskSpec v2 template and its recommended doctor command checks Docker.
6. Independent code review found publication/no-repair ambiguity, failure guidance, continuation task-ID loss, owner-gate contradictions, and a nonexistent normalized-spec artifact on legacy runs. These cases are rejected, status-derived, preserved across continuation, classified as blocked where authority is insufficient, and emitted conditionally.
7. Later independent passes found caller-cwd coupling, credential-like free-form values, weak schemas, unsafe generated path quoting, unborn repositories, unsupported preparation contracts, incomplete continuation evidence, and shallow Docker checks. The final implementation rejects or reports these states explicitly and records all post-repair/apply/publication validation stages.

During an early installed-CLI smoke, a command was accidentally launched in the target cwd and transiently changed ignored `node_modules` plus created untracked pnpm metadata. The metadata was removed, dependencies were restored with offline `npm ci`, and the target was reverified with the same HEAD, a clean Git worktree, and `npm ls --depth=0`. No target commit, branch, tracked file, remote, PR, main, production, database, migration, deploy, secret, or provider state changed.

The dogfood was repeated after the first five fixes and the official result fields were inspected directly. A final merged-main smoke is required after PR merge.
