# OPS-PROMOTION-1

RunForge normal autopilot now continues from a deterministic low-risk patch package to a controlled non-main branch, commit, non-force push, and draft PR when the discovered project profile and all four publication authorities allow it.

Real dogfood correctly stopped at patch-package/policy evidence: Управдом and Factory both select `read-only-triage` because discovery finds DB/production-sensitive indicators. Управдом `main` remained clean at `2409eb40522a8b73ce22aa30a884dd777e4958e0`; its existing owner-ready draft PR remains https://github.com/evg-zlg/upravdom/pull/13.

Normal command:

```bash
corepack pnpm dev factory ops run --repo /Users/evgeny/Documents/projects/upravdom --profile auto-low-risk --batch-size 3 --autopilot --out validation/runs/OPS-PROMOTION-1/upravdom
```
