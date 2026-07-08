# RunForge Alpha-20 Knowledge Lifecycle

Generated at: 2026-07-08T17:28:46.176Z
Repo root: /Users/evgeny/Documents/projects/RunForge

## Source Counts

OKF files: 33
Skills: 0
Validation runs: 44
Evidence files: 72

## Lifecycle Status Counts

- candidate: 36
- active: 25
- needs_review: 0
- stale: 16
- duplicate: 0
- missing_evidence: 0
- unsafe: 0
- retired: 0

## Findings

- 16 lifecycle items reference older milestones and should be reviewed.

## Recommendations

- Keep packets and dashboard/index records as runtime truth; use OKF as portable memory.
- Review candidate knowledge and skills before promotion.
- Next milestone: replay and audit existing operator handoff packets in disposable worktrees.

## Operator Trials

- accepted: 3
- rejected: 2
- missing decision: 5
- unsafe mutation: 0

## Operator Handoff Packets

- generated: 1
- missing README: 0
- unsafe: 0
- audited: 2
- audit passed/failed: 1/1
- unsafe handoff rejected: 1

## Operator Handoff Archive

- archived handoffs: 9
- audited handoffs: 3
- accepted handoffs: 4
- rejected handoffs: 3
- unsafe rejected handoffs: 1
- missing audit handoffs: 6

## Archive Recommendations

- Candidate OKF lesson: accepted audited handoff flow works for repo factory.
- Candidate archive lesson: preserve handoff/audit evidence for repo factory.
- Candidate archive lesson: preserve handoff/audit evidence for repo source.
- Candidate lesson: declined or failed handoff for repo factory; review validation and decision rules.
- Candidate lesson: declined or failed handoff for repo smartsql; review validation and decision rules.
- Candidate safety lesson: rejected unsafe handoff for repo factory; review handoff proposal autoAppliedByRunForge=true.

## Alpha Comparison

- Alpha-17 run evidence is not present as validation/runs/ALPHA-17; Alpha-17 OKF and skills artifacts are covered through generated export, validation, inventory, and curator outputs.
- Alpha-19 added setup policy acceptance evidence across packets, dashboard data, and multi-repo validation.
- Alpha-20 connects those artifacts into a lifecycle report with deterministic status counts, findings, recommendations, and safety summary.
- Alpha-21 records a manual operator accepted-patch trial with validation rerun evidence and no RunForge auto-apply.
- Alpha-22 extends the operator loop to a real external repo disposable copy and records accepted and rejected operator decisions separately.
- Alpha-23 hardens operator patch trial UX with decision summaries, safety lint, and accepted/rejected visibility.
- Alpha-24 generates a portable real-operator handoff packet with manual apply, validation, rollback, decisions, and evidence links.
- Alpha-25 replays and audits operator handoff packets in disposable worktrees, including unsafe-packet rejection evidence.
- Alpha-26 archives and searches handoff/audit evidence with lifecycle recommendations.

## Evidence Links

- validation/runs/ADMIN-UI-2/results.json
- validation/runs/ADMIN-UI-2/summary.md
- validation/runs/ADMIN-UI-3/results.json
- validation/runs/ADMIN-UI-3/summary.md
- validation/runs/ADMIN-UI-4/results.json
- validation/runs/ADMIN-UI-4/summary.md
- validation/runs/ADMIN-UI-ALPHA/results.json
- validation/runs/ADMIN-UI-ALPHA/summary.md
- validation/runs/ALPHA-10/results.json
- validation/runs/ALPHA-10/summary.md
- validation/runs/ALPHA-11/results.json
- validation/runs/ALPHA-11/summary.md

Final verdict: passed

## Commands Run

- pnpm dev knowledge lifecycle-report --runs ./validation/runs --out ./validation/runs/ALPHA-20 --skill-root ./.agents/skills
- pnpm dev skills lifecycle-report --runs ./validation/runs --out /tmp/runforge-demo-skill-lifecycle
- pnpm demo:knowledge-lifecycle

## Source Artifacts Inspected

- validation/runs
- validation/runs/ALPHA-20/generated/okf
- validation/runs/ALPHA-20/generated/skills/skills-inventory.json
- validation/runs/ALPHA-20/generated/curator/skill-candidates.json

## Fixes Applied

- Added deterministic OKF/skills lifecycle status model.
- Added lifecycle report/index CLI surfaces.
- Extended OKF validation and skill curator findings.

## Limitations

- Lifecycle links are local filesystem paths only.
- Duplicate/overlap checks are deterministic heuristics, not semantic review.
- Tracked Alpha-20 evidence scans repo-local skill roots only; local operator skill inventory remains a `/tmp` demo output to avoid committing personal skill names.

Alpha-20 validation: passed
