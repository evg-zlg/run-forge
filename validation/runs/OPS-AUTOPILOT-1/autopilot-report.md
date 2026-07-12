# Autopilot report

The loop accepts unknown repository paths, selects a generic authority profile, removes state/package duplicates, executes deterministic low-risk candidates into patch packages, and stops ambiguous or unsafe work for the owner.

Normal command: `corepack pnpm dev factory ops run --repo /Users/evgeny/Documents/projects/upravdom --profile auto-low-risk --batch-size 3 --autopilot --out validation/runs/OPS-AUTOPILOT-1`
