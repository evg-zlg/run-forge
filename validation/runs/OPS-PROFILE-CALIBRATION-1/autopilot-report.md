# Autopilot report

The loop accepts unknown repository paths, selects a bounded authority profile, removes state/package/branch/PR duplicates, executes deterministic low-risk candidates into patch packages, and promotes them to owner-ready draft PRs only when every publication authority and safety gate passes.

Normal command: `corepack pnpm dev factory ops run --repo /Users/evgeny/Documents/projects/factory --profile auto-low-risk --batch-size 3 --autopilot --out validation/runs/OPS-PROFILE-CALIBRATION-1`
