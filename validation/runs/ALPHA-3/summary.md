# Alpha-3 Validation

Raw artifacts: /tmp/runforge-alpha3-aPCLha

| Case | Kind | Status | Expected | Actual | Packet |
| --- | --- | --- | --- | --- | --- |
| ready from test assertion failure | readiness | passed | ready_for_code_proposal | ready_for_code_proposal | /tmp/runforge-alpha3-aPCLha/ready-from-test-assertion-failure/packet |
| ready from typecheck-style evidence | readiness | passed | ready_for_code_proposal | ready_for_code_proposal | /tmp/runforge-alpha3-aPCLha/ready-from-typecheck-style-evidence/packet |
| needs_more_context from dependency_missing | readiness | passed | needs_more_context | needs_more_context | /tmp/runforge-alpha3-aPCLha/needs-more-context-from-dependency-missing/packet |
| needs_more_context from command_not_found | readiness | passed | needs_more_context | needs_more_context | /tmp/runforge-alpha3-aPCLha/needs-more-context-from-command-not-found/packet |
| research_only from timeout | readiness | passed | research_only | research_only | /tmp/runforge-alpha3-aPCLha/research-only-from-timeout/packet |
| no_failure_observed from passed packet | readiness | passed | no_failure_observed | no_failure_observed | /tmp/runforge-alpha3-aPCLha/no-failure-observed-from-passed-packet/packet |
| blocked_by_safety synthetic case | readiness | passed | blocked_by_safety | blocked_by_safety | /tmp/runforge-alpha3-aPCLha/readiness-blocked-by-safety/packet |
| verified fixture after command passes | code-proposal | passed | proposal_ready_verified | proposal_ready_verified | /tmp/runforge-alpha3-aPCLha/code-proposal-verified/packet |
| ready fixture proposal patch generated | code-proposal | passed | patchBytes > 0 | 321 | /tmp/runforge-alpha3-aPCLha/code-proposal-ready-patch/packet |
| not-ready readiness packet no patch generated | code-proposal | passed | not_ready | not_ready | /tmp/runforge-alpha3-aPCLha/code-proposal-not-ready/packet |
| ambiguous failure no_safe_proposal | code-proposal | passed | no_safe_proposal | no_safe_proposal | /tmp/runforge-alpha3-aPCLha/code-proposal-no-safe/packet |
| verification failure honest verification_failed | code-proposal | passed | verification_failed | verification_failed | /tmp/runforge-alpha3-aPCLha/code-proposal-verification-failed/packet |
