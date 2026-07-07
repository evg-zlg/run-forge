# Alpha-26 Operator Handoff Archive / Search

Final verdict: passed

## Archive

- Roots scanned: /tmp/runforge-alpha26-handoff-archive/source
- Records: 2
- By repo: {"factory":2}
- By decision: {"accepted":1,"rejected":1}
- By audit: {"failed":1,"passed":1}
- By safety: {"safe":1,"unsafe":1}
- By validation after: {"passed":1,"skipped":1}

## Search

- Accepted/passed matches: 1
- Zero-result matches: 0

## Validation

- Archive validation: passed
- Malformed negative validation: failed as expected

## Visibility

- Packet index has archive: true
- Lifecycle has archive counts: true

## Known Limitations

- Alpha-26 builds a read-only archive/search layer; it does not auto-apply, push, merge, deploy, or promote skills.
- Archive records depend on available local artifacts and tolerate missing optional historical files.

Evidence JSON: validation/runs/ALPHA-26/results.json
