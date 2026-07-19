import type { ControlTaskRecord } from "./contracts.js";

const allocations = { startup: .05, analysis: .1, implementation: .45, validation: .1, repair: .2, review: .07, publication: .03 } as const;

export function buildTimeoutContract(requestedMs: number, effectiveMs: number, controlPlaneCapMs: number, executorCapMs: number, acceptedAt: string): NonNullable<ControlTaskRecord["timeout"]> {
  let elapsed = 0; const accepted = Date.parse(acceptedAt);
  const phaseDeadlines = Object.fromEntries(Object.entries(allocations).map(([phase, fraction]) => { const timeoutMs = Math.floor(effectiveMs * fraction); elapsed += timeoutMs; return [phase, { timeoutMs, deadlineAt: new Date(accepted + elapsed).toISOString() }]; }));
  return { requestedMs, effectiveMs, limitingSource: effectiveMs === requestedMs ? "requested" : effectiveMs === controlPlaneCapMs ? "control_plane_cap" : "executor_cap", phaseDeadlines, watchdogPolicy: `Lease deadline is ${new Date(accepted + effectiveMs).toISOString()}; stale-heartbeat watchdog never substitutes a hidden execution timeout.` };
}
