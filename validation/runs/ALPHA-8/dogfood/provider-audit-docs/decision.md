# Decision

Accepted and manually applied.

The first docs proposal was rejected because the unified diff did not dry-run cleanly. The rejected packet passed packet validation and recorded `providerAudit.rejected: true` with a rejection reason.

The regenerated provider packet proposed only `docs/packet-schema.md`, verified in a disposable workspace, and left the original repository unchanged.
