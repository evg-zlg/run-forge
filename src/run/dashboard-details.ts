import { basename } from "node:path";
import type { DashboardRecord } from "./dashboard-builder.js";

export function renderDetails(record: DashboardRecord): string {
  return `<details>
    <summary>Evidence drilldown</summary>
    <div class="details-body">
      <p><strong>Operator verdict:</strong> ${escapeHtml(operatorVerdictText(record.operatorVerdict))}</p>
      <p><strong>Applied to:</strong> ${escapeHtml(record.decisionAppliedTo || "unknown")}</p>
      <p><strong>RunForge auto-applied:</strong> ${escapeHtml(record.autoAppliedByRunForge === null ? "unknown" : String(record.autoAppliedByRunForge))}</p>
      <p><strong>Validation before/after:</strong> ${escapeHtml(record.validationBefore || "unknown")} -> ${escapeHtml(record.validationAfter || "unknown")}</p>
      <p><strong>Handoff replay audit:</strong> ${escapeHtml(record.handoffAuditStatus || "unknown")}</p>
      <p><strong>Original repo mutated:</strong> ${escapeHtml(record.originalRepoMutated === null ? "unknown" : String(record.originalRepoMutated))}</p>
      <p><strong>Provider status:</strong> ${escapeHtml(record.providerStatus)}</p>
      <p><strong>Reason:</strong> ${escapeHtml(reasonFor(record))}</p>
      <div class="artifact-list">
        ${artifactRow("Packet path", record.packetPath)}
        ${artifactRow("Viewer path", record.viewerPath)}
        ${artifactRow("Summary path", record.summaryPath)}
        ${artifactRow("Validation evidence path", record.validationEvidencePath)}
        ${artifactRow("Provider audit path", record.providerAuditPath)}
        ${artifactRow("Proposal patch path", record.proposalPatchPath)}
        ${artifactRow("Handoff README path", record.handoffReadmePath)}
        ${artifactRow("Handoff JSON path", record.handoffJsonPath)}
        ${artifactRow("Handoff audit report path", record.handoffAuditReportPath)}
        ${artifactRow("Handoff audit result path", record.handoffAuditResultPath)}
        ${artifactRow("Human review path", record.humanReviewPath)}
      </div>
      <p><strong>Safety notes:</strong> ${escapeHtml(record.safetyLabels.join(", ") || "none")}</p>
      <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
    </div>
  </details>`;
}

function artifactRow(label: string, path: string): string {
  return `<div><strong>${escapeHtml(label)}:</strong> ${artifactLink(label, path || "unknown")}</div>`;
}

function artifactLink(label: string, path: string): string {
  if (!path || path === "unknown") return "unknown";
  const href = path.startsWith("/") ? `file://${path}` : path;
  return `<div class="artifact"><a href="${escapeAttr(href)}">${escapeHtml(basename(path) || path)}</a><code aria-label="${escapeAttr(label)}">${escapeHtml(path)}</code></div>`;
}

function operatorVerdictText(verdict: string): string {
  if (verdict === "do_not_apply") return "DO NOT APPLY";
  if (verdict === "no_apply") return "NO AUTO-APPLY";
  return verdict;
}

function reasonFor(record: DashboardRecord): string {
  const priority = ["forbidden_path", "malformed_diff", "dry_run_apply_failed", "verification_failed", "provider_rejected", "do_not_apply"];
  return priority.find((label) => record.safetyLabels.includes(label)) ?? record.outcome;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
