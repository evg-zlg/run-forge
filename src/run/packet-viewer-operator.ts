export function renderOperatorDecision(record: Record<string, unknown> | null): string {
  if (!record) return '<div class="meta">No operator decision recorded for this packet.</div>';
  const apply = asRecord(record.apply);
  const validation = asRecord(record.validation);
  return `<div class="grid">
    ${fact("Decision verdict", String(record.finalOutcome ?? record.decision ?? "unknown"))}
    ${fact("Requested decision", String(record.decision ?? "unknown"))}
    ${fact("Original repo unchanged", String(apply?.originalRepoMutated === false))}
    ${fact("Auto-apply by RunForge", String(record.runforgeAppliedPatch === true))}
    ${fact("Applied to", String(apply?.appliedTo ?? "unknown"))}
    ${fact("Apply mode", String(apply?.mode ?? "unknown"))}
    ${fact("After validation", validation?.passed === true ? "passed" : String(validation?.status ?? "unknown"))}
    ${fact("Reason", String(record.reason || "none"))}
  </div>`;
}

function fact(label: string, value: string): string {
  return `<div class="item"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
