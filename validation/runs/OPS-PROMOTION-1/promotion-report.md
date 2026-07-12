# Promotion report

- Authority gates added: `promote_patch_package_to_branch`, `commit_to_non_main_branch`, `push_non_main_branch`, `create_draft_pr`.
- Duplicate gates: prior ops-state/package, deterministic branch, unexpected remote SHA, existing PR, and stable patch identity across open PRs.
- Publication invariants: non-main branch, ordinary push only, draft PR verification, unchanged clean source HEAD, immutable patch hash, passed offline/static validation.
- Управдом promotion: correctly refused by discovered `read-only-triage`; patch package retained.
- Factory promotion: correctly refused by discovered `read-only-triage`; no safe executable package selected.
