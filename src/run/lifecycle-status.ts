export const lifecycleStatuses = ["candidate", "active", "needs_review", "stale", "duplicate", "missing_evidence", "unsafe", "retired"] as const;
export type LifecycleStatus = typeof lifecycleStatuses[number];
