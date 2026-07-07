# RunForge Alpha-20 Knowledge Lifecycle

Generated at: 2026-07-07T05:45:41.229Z
Repo root: /Users/evgeny/Documents/projects/RunForge

## Source Counts

OKF files: 33
Skills: 0
Validation runs: 40
Evidence files: 64

## Lifecycle Status Counts

- candidate: 35
- active: 22
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
- Next milestone: harden the operator patch trial UX around proposal packets, patches, validation, decisions, dashboard rows, and lifecycle entries.

## Operator Trials

- accepted: 3
- rejected: 2
- missing decision: 2
- unsafe mutation: 0

## Alpha Comparison

- Alpha-17 run evidence is not present as validation/runs/ALPHA-17; Alpha-17 OKF and skills artifacts are covered through generated export, validation, inventory, and curator outputs.
- Alpha-19 added setup policy acceptance evidence across packets, dashboard data, and multi-repo validation.
- Alpha-20 connects those artifacts into a lifecycle report with deterministic status counts, findings, recommendations, and safety summary.
- Alpha-21 records a manual operator accepted-patch trial with validation rerun evidence and no RunForge auto-apply.
- Alpha-22 extends the operator loop to a real external repo disposable copy and records accepted and rejected operator decisions separately.
- Alpha-23 hardens operator patch trial UX with decision summaries, safety lint, and accepted/rejected visibility.

## Evidence Links

- validation/runs/ADMIN-UI-2/results.json
- validation/runs/ADMIN-UI-2/summary.md
- validation/runs/ADMIN-UI-3/results.json
- validation/runs/ADMIN-UI-3/summary.md
- validation/runs/ADMIN-UI-ALPHA/results.json
- validation/runs/ADMIN-UI-ALPHA/summary.md
- validation/runs/ALPHA-10/results.json
- validation/runs/ALPHA-10/summary.md
- validation/runs/ALPHA-11/results.json
- validation/runs/ALPHA-11/summary.md
- validation/runs/ALPHA-12/results.json
- validation/runs/ALPHA-12/summary.md

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
