# RunForge Alpha Snapshot - 2026-07-02

Current `main` SHA at snapshot start: `0b4f418cc9cc913a47b70502ac2e280c2d775e4b`.

## What RunForge can do now

RunForge can produce a local, deterministic, proposal-only artifact packet for a narrow external docs update. Given an explicit RunSpec, a local target repository, scoped evidence files, a target file, an exact anchor, and reviewed insertion text, it can:

- collect bounded context into `context-pack.json` and `context-pack.md`;
- generate a unified `proposal.patch` without mutating the target repository;
- write `patch-summary.md`, `proposal-status.json`, `safety-report.json`, `trajectory.json`, `run-spec.json`, and `human-review.md`;
- run `git apply --check` against the target repo when a patch is generated;
- leave the final apply decision to a human reviewer.

The validated wedge is external docs proposal. It is intentionally smaller than generic code generation.

## External validation

| Project | Outcome | Packet | Patch | Apply check | Mutation |
| --- | --- | --- | --- | --- | --- |
| SmartSQL | `proposal_ready` | complete packet | non-empty `proposal.patch`; apply-check passed | passed | no mutation |
| PartKom B2C | `proposal_ready` | complete packet | `proposal.patch` 439 bytes | `git apply --check` passed | no mutation |
| Factory | `proposal_ready` | complete packet | `proposal.patch` 479 bytes | `git apply --check` passed | no mutation |

## Artifact contract

An alpha external docs proposal packet is expected to include:

- `human-review.md`
- `context-pack.json`
- `context-pack.md`
- `proposal.patch`
- `patch-summary.md`
- `proposal-status.json`
- `safety-report.json`
- `trajectory.json`
- `run-spec.json`

`proposal-status.json` is the machine-readable outcome record. `patch-summary.md` and `human-review.md` are reviewer-facing. `proposal.patch` is a proposal artifact only; a human may apply it manually outside RunForge after review.

## Safety guarantees

- RunForge does not mutate the target repository during external docs proposal generation.
- RunForge does not apply patches.
- RunForge does not push branches.
- RunForge does not create pull requests.
- RunForge does not merge.
- RunForge requires a human decision before any proposed change is applied.
- Missing evidence, missing anchors, scope violations, or failed proposal steps produce explicit no-proposal or blocked artifacts instead of silent writes.

## Known limitations

- The alpha wedge only supports a narrow docs insertion flow: one target file, exact anchor text, reviewed insertion text, and declared evidence files.
- It does not perform semantic rewriting or broad multi-file planning.
- It does not validate generic code changes against external projects.
- It does not triage arbitrary CI failures outside the checked-in fixtures.
- It does not call an LLM or external provider.
- It is local-only and not remote or hosted.
- `patchBytes` now represents UTF-8 byte length for generated proposal status and external review packet metadata. Earlier external dogfood notes may have recorded character-count-like values for non-ASCII patch context.

## Explicitly not included

This alpha does not include SaaS hosting, a dashboard, remote compute, queues, LLM/API calls, auto-PR, auto-merge, apply mode, generic LLM proposal generation, remote workers, or new runtime features beyond the local artifact flow.

## Recommended next product directions

- Keep the product centered on artifact-first, human-gated engineering runs.
- Strengthen the external docs proposal contract with more fixture coverage for encoding, anchors, empty patches, and evidence failures.
- Add a reviewed alpha trial checklist that separates artifact validity, patch applicability, and target-repo cleanliness.
- Define the next validated wedge before expanding runtime surface area. Good candidates are deterministic test evidence packets or tightly scoped fixture-backed code proposals.
- Improve reviewer ergonomics in the packet before adding hosting or automation.
