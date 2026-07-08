# Alpha-27 Operator Handoff Archive Viewer

Final verdict: passed

## Viewer

- Archive source: /tmp/runforge-alpha27-handoff-archive-viewer/archive/handoff-archive.json
- Viewer command: pnpm dev external handoff-archive-viewer --archive /tmp/runforge-alpha27-handoff-archive-viewer/archive/handoff-archive.json --out /tmp/runforge-alpha27-handoff-archive-viewer/viewer
- Viewer output: /tmp/runforge-alpha27-handoff-archive-viewer/viewer
- Tracked viewer: validation/runs/ALPHA-27/viewer/index.html
- Records rendered: 2
- Counts rendered: {"records":2,"byRepo":{"factory":2},"byDecision":{"accepted":1,"rejected":1},"byAuditStatus":{"failed":1,"passed":1},"bySafetyStatus":{"safe":1,"unsafe":1},"byValidationAfter":{"passed":1,"skipped":1}}
- Viewer validation: passed

## Filters

- Repo substring: true
- Decision/audit/safety/validation/original-mutation filters: true
- Zero-result message: No handoff archive records match the current filters.

## Safety

- Read-only static viewer: true
- No original external repo mutation: true
- Unsafe commands redacted in viewer data: true
- Unsafe/rejected records marked: true

## Visibility

- Packet index has viewer: true
- Dashboard data has viewer: true
- Lifecycle has archive counts: true
- Lifecycle report: validation/runs/ALPHA-27/lifecycle-report.json

## Known Limitations

- Alpha-27 is a static local viewer over existing archive artifacts; it does not auto-apply, push, merge, deploy, or promote skills.
- File links are rendered as local paths for operator copy/open workflows; no server or browser automation is required.

Evidence JSON: validation/runs/ALPHA-27/results.json
