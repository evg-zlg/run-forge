# Operator Handoff Archive

Generated at: 2026-07-08T17:30:48.464Z
Root: /tmp/runforge-alpha26-handoff-archive/source

## Counts

- records: 2
- by repo: factory = 2
- by decision: accepted = 1
- by decision: rejected = 1
- by audit: failed = 1
- by audit: passed = 1
- by safety: safe = 1
- by safety: unsafe = 1
- by validation after: passed = 1
- by validation after: skipped = 1

## Records

| ID | Repo | Decision | Audit | Safety | Validation | Handoff | Audit report |
| --- | --- | --- | --- | --- | --- | --- | --- |
ALPHA-26-DEMO__accepted-handoff | factory | accepted | passed | safe | failed->passed | /tmp/runforge-alpha26-handoff-archive/source/ALPHA-26-DEMO/accepted-handoff/README.md | /tmp/runforge-alpha26-handoff-archive/source/ALPHA-26-DEMO/accepted-audit/audit-report.md
ALPHA-26-DEMO__unsafe-handoff | factory | rejected | failed | unsafe | failed->skipped | /tmp/runforge-alpha26-handoff-archive/source/ALPHA-26-DEMO/unsafe-handoff/README.md | /tmp/runforge-alpha26-handoff-archive/source/ALPHA-26-DEMO/unsafe-audit/audit-report.md

## Recommendations

- Candidate OKF lesson: accepted audited handoff flow works for repo factory.
- Candidate safety lesson: rejected unsafe handoff for repo factory; review handoff safety.pushUsed=true.

Validation: passed
