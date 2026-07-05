# RunForge Alpha-7 Validation

Generated at: 2026-07-05T07:13:56.154Z

Raw outputs:
- /tmp/runforge-alpha7-blackbox
- Packet validation: /tmp/runforge-alpha7-packet-validation
- Viewer: /tmp/runforge-alpha7-blackbox/viewer-code-proposal/index.html

Black-box coverage:
- packet validation passes for all current packet types
- packet validation fails for a deliberately broken packet
- provider valid fixture patch accepted and verified
- provider forbidden .env patch rejected
- provider malformed diff rejected
- provider path traversal rejected
- provider allowlist violation rejected
- static packet viewer generated for a code proposal packet
- viewer output contains graph/worker/status/artifact information
- original provider repos stayed unchanged

Results:
- PASS packet validation sweep (exit 0)
- PASS provider valid fixture patch accepted (exit 0)
- PASS assert /tmp/runforge-alpha7-blackbox/provider-valid status (exit 0)
- PASS provider forbidden .env patch rejected (exit 0)
- PASS assert /tmp/runforge-alpha7-blackbox/provider-forbidden-env status (exit 0)
- PASS provider malformed diff rejected (exit 0)
- PASS assert /tmp/runforge-alpha7-blackbox/provider-malformed status (exit 0)
- PASS provider path traversal rejected (exit 0)
- PASS assert /tmp/runforge-alpha7-blackbox/provider-path-traversal status (exit 0)
- PASS create allowlist readiness source (exit 0)
- PASS provider allowlist violation rejected (exit 0)
- PASS assert /tmp/runforge-alpha7-blackbox/provider-allowlist status (exit 0)
- PASS static packet viewer generated (exit 0)
- PASS viewer output contains graph/worker/status/artifact information (exit 0)

Original repo states:
- valid: "bad\n"
- forbidden: "bad\n"
- malformed: "bad\n"
- traversal: "bad\n"
- allowlist: "bad\n"
