# RunForge Packet Validation

Generated at: 2026-07-08T17:28:12.926Z

Raw outputs:
- /tmp/runforge-alpha7-packet-validation
- Viewer: /tmp/runforge-alpha7-packet-validation/viewer-code-proposal/index.html

Validated packet types:
- external check
- failure triage
- proposal readiness
- code proposal
- provider proposal

Results:
- PASS generate external check packet (exit 0)
- PASS generate failure triage packet (exit 0)
- PASS generate proposal readiness packet (exit 0)
- PASS generate code proposal packet (exit 0)
- PASS generate provider proposal packet (exit 0)
- PASS validate external check packet (exit 0)
- PASS validate failure triage packet (exit 0)
- PASS validate proposal readiness packet (exit 0)
- PASS validate code proposal packet (exit 0)
- PASS validate provider proposal packet (exit 0)
- PASS broken packet validation fails (exit 1)
- PASS generate static packet viewer (exit 0)
- PASS viewer contains graph/status/artifact information (exit 0)

Negative validation:
- A deliberately broken packet without runId failed packet inspector validation.

Original repo mutation check:
- Provider repo: /var/folders/qp/bdzz2jbs5dnbyz1d1hj_r99r0000gn/T/runforge-alpha7-provider-repo-biiLh0
- state.txt after provider run: "bad\n"

Viewer:
- Static HTML viewer was generated and checked for graph/status/artifact information.
