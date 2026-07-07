# RunForge Alpha-19 Multi-Repo Setup Policy Acceptance

Generated at: 2026-07-07T05:45:34.911Z
Raw outputs: /tmp/runforge-alpha19-acceptance
Final verdict: passed

External repositories:
- factory: /Users/evgeny/Documents/projects/factory; before d65ab9a9c8130f5d2c9214e8fdde2a278578afed / ""; after d65ab9a9c8130f5d2c9214e8fdde2a278578afed / ""; unchanged true
- smartsql: /Users/evgeny/Documents/projects/smartsql; before 71e2c386bfc21adfae2d0101712fb42dae46e6e1 / "?? _experiments/\n?? output/\n?? reports/agent-factory/bindings/\n?? reports/ai-club/\n?? reports/owner-context/moysklad-amocrm-proof-of-link-mvp-20260625.md\n?? reports/projectops/CRM-W-2645-R001.json\n?? reports/projectops/FIN-W-2315-R001.json\n?? reports/projectops/OPS-W-2583-R001.json\n?? reports/projectops/OPS-W-2697-R001.json\n?? tmp/"; after 71e2c386bfc21adfae2d0101712fb42dae46e6e1 / "?? _experiments/\n?? output/\n?? reports/agent-factory/bindings/\n?? reports/ai-club/\n?? reports/owner-context/moysklad-amocrm-proof-of-link-mvp-20260625.md\n?? reports/projectops/CRM-W-2645-R001.json\n?? reports/projectops/FIN-W-2315-R001.json\n?? reports/projectops/OPS-W-2583-R001.json\n?? reports/projectops/OPS-W-2697-R001.json\n?? tmp/"; unchanged true

Scenarios:
- PASS scenario-1-setup-pass: setup passes and main passes (exit 0, 559ms)
- PASS scenario-2-setup-fail: setup fails and main commands are skipped (exit 0, 431ms)
- PASS scenario-2-readiness-gated: setup failure propagates through triage/readiness (exit 0, 458ms)
- PASS scenario-3-diagnostic: setup fails and diagnostic main command fails (exit 0, 459ms)
- PASS scenario-4-network-expected: setup network intent expected is recorded as audit-only (exit 0, 466ms)
- PASS scenario-5-invalid-intent: invalid setup network intent fails clearly (exit 1, 357ms)
- PASS scenario-6-factory: factory safe external check (exit 0, 625ms)
- PASS scenario-7-smartsql: smartsql safe external check (exit 0, 5740ms)
- PASS scenario-8-code-proposal-gated: chained code-proposal with setup failure does not generate a patch (exit 0, 446ms)
- PASS packet-validate-ALPHA-19__setup-pass: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-pass/packet (exit 0, 360ms)
- PASS packet-view-ALPHA-19__setup-pass: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-pass/packet (exit 0, 332ms)
- PASS packet-validate-ALPHA-19__setup-fail: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail/packet (exit 0, 340ms)
- PASS packet-view-ALPHA-19__setup-fail: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail/packet (exit 0, 339ms)
- PASS packet-validate-ALPHA-19__setup-fail-readiness: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/packet (exit 0, 332ms)
- PASS packet-view-ALPHA-19__setup-fail-readiness: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/packet (exit 0, 328ms)
- PASS packet-validate-ALPHA-19__setup-diagnostic: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-diagnostic/packet (exit 0, 330ms)
- PASS packet-view-ALPHA-19__setup-diagnostic: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-diagnostic/packet (exit 0, 342ms)
- PASS packet-validate-ALPHA-19__setup-network-expected: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-network-expected/packet (exit 0, 332ms)
- PASS packet-view-ALPHA-19__setup-network-expected: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-network-expected/packet (exit 0, 333ms)
- PASS packet-validate-ALPHA-19__factory: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/factory/packet (exit 0, 330ms)
- PASS packet-view-ALPHA-19__factory: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/factory/packet (exit 0, 333ms)
- PASS packet-validate-ALPHA-19__smartsql: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/smartsql/packet (exit 0, 332ms)
- PASS packet-view-ALPHA-19__smartsql: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/smartsql/packet (exit 0, 377ms)
- PASS packet-validate-ALPHA-19__chained-setup-fail: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/packet (exit 0, 346ms)
- PASS packet-view-ALPHA-19__chained-setup-fail: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/packet (exit 0, 336ms)
- PASS packet-validate-ALPHA-19__chained-setup-fail__readiness-source: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/packet (exit 0, 335ms)
- PASS packet-view-ALPHA-19__chained-setup-fail__readiness-source: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/packet (exit 0, 331ms)
- PASS packet-validate-ALPHA-19__chained-setup-fail__readiness-source__triage-source__check-source: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/check-source/packet (exit 0, 339ms)
- PASS packet-view-ALPHA-19__chained-setup-fail__readiness-source__triage-source__check-source: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/check-source/packet (exit 0, 371ms)
- PASS packet-validate-ALPHA-19__chained-setup-fail__readiness-source__triage-source: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/packet (exit 0, 352ms)
- PASS packet-view-ALPHA-19__chained-setup-fail__readiness-source__triage-source: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/packet (exit 0, 348ms)
- PASS packet-validate-ALPHA-19__setup-fail-readiness__triage-source__check-source: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/check-source/packet (exit 0, 349ms)
- PASS packet-view-ALPHA-19__setup-fail-readiness__triage-source__check-source: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/check-source/packet (exit 0, 335ms)
- PASS packet-validate-ALPHA-19__setup-fail-readiness__triage-source: validate packet /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/packet (exit 0, 333ms)
- PASS packet-view-ALPHA-19__setup-fail-readiness__triage-source: render packet viewer /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/packet (exit 0, 340ms)
- PASS packet-index: build packet index and dashboard seed (exit 0, 396ms)
- PASS dashboard-build: build setup-policy acceptance dashboard (exit 0, 343ms)

Packets:
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-pass/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-diagnostic/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-network-expected/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/factory/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/smartsql/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/check-source/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/chained-setup-fail/readiness-source/triage-source/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/check-source/packet
- /tmp/runforge-alpha19-acceptance/ALPHA-19/setup-fail-readiness/triage-source/packet

Viewers and dashboard:
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-pass/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-fail/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-fail-readiness/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-diagnostic/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-network-expected/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__factory/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__smartsql/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__chained-setup-fail/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__chained-setup-fail__readiness-source/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__chained-setup-fail__readiness-source__triage-source__check-source/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__chained-setup-fail__readiness-source__triage-source/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-fail-readiness__triage-source__check-source/index.html
- /tmp/runforge-alpha19-acceptance/viewers/ALPHA-19__setup-fail-readiness__triage-source/index.html
- /tmp/runforge-alpha19-acceptance/dashboard/index.html

Findings and fixes:
- Packet validation now checks setupPolicy shape on external command-check packet surfaces.
- Packet viewers render setup policy and setup command results explicitly.
- Dashboard seed/data includes setup network intent and diagnostic mode, with tags and a filter.

Errors: none
