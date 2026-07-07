import type { AdminData } from "./builder.js";

export function renderAdminHtml(data: AdminData): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunForge Admin UI Alpha</title>
  <style>${adminCss()}</style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">RunForge Admin UI Alpha</p>
      <h1>Local Operator Console</h1>
      <p class="lede">${escapeHtml(data.runForge.repoPath)} at ${escapeHtml(data.runForge.sha)}</p>
    </div>
    <dl class="metrics">
      ${metric("Repos", data.overview.repositoryCount)}
      ${metric("Providers", data.overview.providerCount)}
      ${metric("Indexed runs", data.overview.indexedRunCount)}
      ${metric("Latest alpha", data.overview.latestValidationAlpha)}
      ${metric("Do not apply", data.overview.urgentSafetyCounts.do_not_apply)}
      ${metric("Provider rejected", data.overview.urgentSafetyCounts.provider_rejected)}
    </dl>
  </header>
  <main>
    <nav>
      <a href="#overview">Overview</a>
      <a href="#repositories">Repositories</a>
      <a href="#providers">Providers</a>
      <a href="#runs">Runs</a>
      <a href="#details">Run detail</a>
      <a href="#compare">Compare</a>
      <a href="#settings">Settings</a>
    </nav>
    ${overviewSection(data)}
    ${repositoriesSection(data)}
    ${providersSection(data)}
    ${runsSection(data)}
    ${detailsSection(data)}
    ${compareSection(data)}
    ${settingsSection(data)}
  </main>
  <script id="admin-data" type="application/json">${payload}</script>
  <script>${adminJs()}</script>
</body>
</html>
`;
}

function overviewSection(data: AdminData): string {
  const urgentRuns = data.runs.filter((run) => run.urgent).slice(0, 8).map((run) => `<tr>
    <td>${escapeHtml(run.alpha)}</td><td>${escapeHtml(run.repo)}</td><td>${escapeHtml(run.scenario)}</td>
    <td>${badge(run.outcome)}</td><td>${safetyFlags(run.safetyFlags)}</td><td><a href="#details" data-open-detail="${escapeAttr(run.id)}" onclick="openRunDetailById('${escapeAttr(run.id)}');return false">open</a></td>
  </tr>`).join("");
  return `<section id="overview">
    <div class="section-title"><h2>Overview</h2><span>${escapeHtml(data.generatedAt)}</span></div>
    <dl class="settings overview-facts">
      <dt>RunForge path</dt><dd><code>${escapeHtml(data.runForge.repoPath)}</code></dd>
      <dt>RunForge SHA</dt><dd><code>${escapeHtml(data.runForge.sha)}</code></dd>
      <dt>Config path</dt><dd><code>${escapeHtml(data.configPath)}</code></dd>
    </dl>
    <div class="split">
      ${countsTable("Outcomes", data.overview.byOutcome)}
      ${countsTable("Provider status", data.overview.byProviderStatus)}
      ${countsTable("Operator attention", data.overview.urgentSafetyCounts)}
    </div>
    <h3>Operator Queue</h3>
    <div class="split">
      ${countsTable("Recommended Next Actions", {
        safe_read_only: data.actionQueue.runsWithSafeReadOnlyActions,
        caution: data.actionQueue.runsRequiringCaution,
        blocked: data.actionQueue.runsBlockedBySafety
      })}
      ${countsTable("Proposal / Setup", {
        verified_proposals: data.actionQueue.runsWithVerifiedProposals,
        setup_failures: data.actionQueue.runsWithSetupFailures,
        mutating_previews: data.actionQueue.runsWithMutatingPreviews
      })}
      ${countsTable("Failure Follow-up", {
        provider_rejections: data.actionQueue.runsWithProviderRejections,
        verification_failures: data.actionQueue.runsWithVerificationFailures,
        no_recommended_action: data.actionQueue.runsWithNoRecommendedAction
      })}
    </div>
    <h3>Urgent / Safety Relevant</h3>
    <table><thead><tr><th>Alpha</th><th>Repo</th><th>Scenario</th><th>Outcome</th><th>Flags</th><th></th></tr></thead><tbody>${urgentRuns || emptyRow(6)}</tbody></table>
  </section>`;
}

function repositoriesSection(data: AdminData): string {
  const rows = data.repositories.map((repo) => `<tr>
    <td>${escapeHtml(repo.name)}</td><td><code>${escapeHtml(repo.path)}</code></td><td>${badge(repo.exists ? "exists" : "missing")}</td>
    <td>${escapeHtml(repo.gitHead)}</td><td>${badge(repo.gitStatus)}</td><td>${escapeHtml(repo.tags.join(", ") || "none")}</td><td>${escapeHtml(repo.lastObservedRun)}</td>
  </tr>`).join("");
  return `<section id="repositories"><div class="section-title"><h2>Repositories</h2><span>${data.repositories.length} configured</span></div>
    <table><thead><tr><th>Name</th><th>Path</th><th>Exists</th><th>HEAD</th><th>Status</th><th>Tags</th><th>Last observed run</th></tr></thead><tbody>${rows || emptyRow(7)}</tbody></table>
  </section>`;
}

function providersSection(data: AdminData): string {
  const rows = data.providers.map((provider) => `<tr>
    <td>${escapeHtml(provider.id)}</td><td>${escapeHtml(provider.type)}</td><td>${badge(provider.enabled ? "enabled" : "disabled")}</td>
    <td><code>${escapeHtml(provider.apiKeyRef)}</code></td><td>${badge(provider.tokenStatus)}</td><td>${escapeHtml(provider.defaultModel)}</td><td>${escapeHtml(provider.command)}</td>
  </tr>`).join("");
  return `<section id="providers"><div class="section-title"><h2>Providers</h2><span>No provider calls are made by this UI</span></div>
    <table><thead><tr><th>ID</th><th>Type</th><th>Enabled</th><th>Token ref</th><th>Token status</th><th>Default model</th><th>Command</th></tr></thead><tbody>${rows || emptyRow(7)}</tbody></table>
  </section>`;
}

function runsSection(data: AdminData): string {
  const rows = data.runs.map((run) => `<tr class="run-row${run.urgent ? " urgent-row" : ""}" data-id="${escapeAttr(run.id)}" data-repo="${escapeAttr(run.repo)}" data-outcome="${escapeAttr(run.outcome)}" data-provider="${escapeAttr(run.providerStatus)}" data-alpha="${escapeAttr(run.alpha)}" data-packet-type="${escapeAttr(run.packetType)}" data-operator="${escapeAttr(run.operatorVerdict)}" data-mutation="${escapeAttr(run.mutationVerdict)}" data-dna="${run.doNotApply}" data-provider-rejected="${run.providerRejected}" data-verification-failed="${run.verificationFailed}" data-setup="${run.setupFailure}" data-proposal="${run.hasProposal}" data-verified="${run.verifiedProposal}" data-viewer="${run.hasViewer}" data-summary="${run.hasSummary}" data-action-safe="${run.actionSummary?.hasSafeAction ?? false}" data-action-caution="${run.actionSummary?.hasCautionAction ?? false}" data-action-blocked="${run.actionSummary?.hasBlockedAction ?? false}" data-action-mutating="${run.actionSummary?.hasMutatingPreview ?? false}" data-action-none="${run.actionSummary?.hasRecommendedAction === false}" data-urgent="${run.urgent}" data-updated="${escapeAttr(run.updatedAt)}">
    <td><input type="checkbox" class="compare-pick" aria-label="Compare ${escapeAttr(run.alpha)} ${escapeAttr(run.scenario)}" value="${escapeAttr(run.id)}"></td>
    <td><a href="#details" data-open-detail="${escapeAttr(run.id)}" onclick="openRunDetailById('${escapeAttr(run.id)}');return false">${escapeHtml(run.alpha)}</a><small>${escapeHtml(dateShort(run.updatedAt))}</small></td>
    <td>${escapeHtml(run.repo)}</td><td>${escapeHtml(run.scenario)}</td><td>${escapeHtml(run.packetType)}</td>
    <td>${badge(run.outcome)}</td><td>${badge(run.providerStatus)}</td><td>${badge(run.operatorVerdict)}</td><td>${badge(run.mutationVerdict)}</td>
    <td>${badge(run.setupStatus)}</td><td>${badge(run.proposalStatus)}</td><td>${actionBadge(run)}</td><td>${safetyFlags(run.safetyFlags)}</td>
    <td>${pathControl(run.packetPath, "Packet")}</td><td>${pathControl(run.summaryPath, "Summary")}</td><td>${pathControl(run.viewerPath, "Viewer")}</td><td>${pathControl(run.dashboardPath, "Dashboard")}</td>
  </tr>`).join("");
  return `<section id="runs">
    <div class="section-title"><h2>Runs Browser</h2><span><strong id="visible-runs">${data.runs.length}</strong> visible / ${data.runs.length} indexed</span></div>
    <div class="filters">
      <input id="run-search" type="search" placeholder="Search repo, scenario, path, status" aria-label="Search runs">
      ${select("repo-filter", "Repo", unique(data.runs.map((run) => run.repo)))}
      ${select("outcome-filter", "Outcome", unique(data.runs.map((run) => run.outcome)))}
      ${select("provider-filter", "Provider", unique(data.runs.map((run) => run.providerStatus)))}
      ${select("alpha-filter", "Alpha", unique(data.runs.map((run) => run.alpha)))}
      ${select("packet-filter", "Packet", unique(data.runs.map((run) => run.packetType)))}
      ${select("operator-filter", "Operator", unique(data.runs.map((run) => run.operatorVerdict)))}
      ${select("mutation-filter", "Mutation", unique(data.runs.map((run) => run.mutationVerdict)))}
      <select id="sort-filter" aria-label="Sort runs"><option value="newest">Newest first</option><option value="outcome">Outcome</option><option value="repo">Repo</option><option value="alpha">Alpha</option><option value="provider">Provider status</option></select>
      <button type="button" data-quick="urgent">urgent</button>
      <button type="button" data-quick="do_not_apply">do_not_apply</button>
      <button type="button" data-quick="provider_rejected">provider rejected</button>
      <button type="button" data-quick="verification_failed">verification failed</button>
      <button type="button" data-quick="setup">setup failures</button>
      <button type="button" data-quick="proposal">has proposal</button>
      <button type="button" data-quick="verified">verified proposal</button>
      <button type="button" data-quick="viewer">has viewer</button>
      <button type="button" data-quick="summary">has summary</button>
      <button type="button" data-quick="action_safe">safe action</button>
      <button type="button" data-quick="action_caution">caution action</button>
      <button type="button" data-quick="action_blocked">blocked action</button>
      <button type="button" data-quick="action_mutating">mutating preview</button>
      <button type="button" data-quick="action_none">no recommended action</button>
      <button type="button" id="reset-filters">reset</button>
    </div>
    <table class="runs-table"><thead><tr><th></th><th>Alpha</th><th>Repo</th><th>Scenario</th><th>Packet type</th><th>Outcome</th><th>Provider</th><th>Operator</th><th>Mutation</th><th>Setup</th><th>Proposal</th><th>Actions</th><th>Safety</th><th>Packet</th><th>Summary</th><th>Viewer</th><th>Dashboard</th></tr></thead><tbody id="runs-body">${rows || emptyRow(17)}</tbody></table>
  </section>`;
}

function detailsSection(data: AdminData): string {
  const runsByPacket = new Map(data.runs.map((run) => [run.packetPath, run]));
  const items = data.runDetails.map((detail) => {
    const run = runsByPacket.get(detail.packetPath);
    const links = run ? data.artifactLinks[run.id] ?? [] : [];
    return `<details class="run-detail" data-detail-id="${escapeAttr(run?.id ?? detail.packetPath)}">
    <summary><span>${escapeHtml(run ? `${run.alpha} / ${run.repo} / ${run.scenario}` : detail.packetPath)}</span>${run?.urgent ? badge("urgent") : ""}<small>${detail.graph.length} timeline nodes, ${escapeHtml(detail.graphSource)}</small></summary>
    ${run ? `<div class="summary-card ${run.urgent ? "unsafe" : ""}">
      <div><h3>${escapeHtml(run.outcome)}</h3><p>${escapeHtml(run.packetType)} for ${escapeHtml(run.repo)} / ${escapeHtml(run.scenario)}</p></div>
      <dl>${miniFact("Provider", run.providerStatus)}${miniFact("Operator", run.operatorVerdict)}${miniFact("Mutation", run.mutationVerdict)}${miniFact("Setup", run.setupStatus)}${miniFact("Proposal", run.proposalStatus)}${miniFact("Safety", run.safetyFlags.join(", ") || "none")}</dl>
    </div>` : ""}
    <p>${escapeHtml(detail.summary)}</p>
    <ol class="graph">${detail.graph.map((node) => `<li data-status="${escapeAttr(node.status)}"><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.status)}</span><small>${escapeHtml([node.timestamp, node.durationMs === null ? "" : `${node.durationMs}ms`, node.detail].filter(Boolean).join(" | "))}</small></li>`).join("")}</ol>
    <div class="artifact-list"><h3>Important paths</h3>${links.map((link) => pathControl(link.path, link.label, link.route)).join("") || "<p>No artifact links were available.</p>"}</div>
    ${run ? actionPreviewSection(data.actionPreviews[run.id] ?? []) : ""}
    <div class="detail-grid">
      ${jsonBlock("Validation summary", detail.validationSummary)}
      ${jsonBlock("Metrics", detail.metrics)}
      ${jsonBlock("Safety", detail.safety)}
      ${jsonBlock("Setup policy", detail.setupPolicy)}
      ${jsonBlock("Provider audit", detail.providerAudit)}
      ${jsonBlock("Proposal status", detail.proposalStatus)}
      ${jsonBlock("Proposal readiness", detail.proposalReadiness)}
      <div><h3>Artifacts</h3><ul>${detail.artifacts.map((artifact) => `<li>${escapeHtml(artifact)}</li>`).join("") || "<li>none</li>"}</ul></div>
    </div>
  </details>`;
  }).join("");
  return `<section id="details"><div class="section-title"><h2>Run Detail / Timeline</h2><span>${data.runDetails.length} loaded</span></div>${items || "<p>No packet details were available.</p>"}</section>`;
}

function compareSection(data: AdminData): string {
  return `<section id="compare">
    <div class="section-title"><h2>Compare Runs</h2><span>Pick two runs in the browser</span></div>
    <div class="compare-controls">
      ${runSelect("compare-left", "Left run", data.runs)}
      ${runSelect("compare-right", "Right run", data.runs)}
      <button type="button" id="compare-clear">clear</button>
    </div>
    <div id="compare-output" class="compare-output">Select two runs to compare key fields.</div>
  </section>`;
}

function actionBadge(run: AdminData["runs"][number]): string {
  const summary = run.actionSummary;
  if (!summary) return badge("no_actions");
  const title = `${summary.count} previews; next: ${summary.recommendedTitle}`;
  return `<span class="action-cell" title="${escapeAttr(title)}">${badge(`${summary.count} actions`)}${badge(`safety_${summary.highestSafety}`)}${summary.blockedCount ? badge(`${summary.blockedCount} blocked`) : ""}<small>${escapeHtml(summary.recommendedTitle)}</small></span>`;
}

function actionPreviewSection(actions: AdminData["actionPreviews"][string]): string {
  const cards = actions.map((action) => {
    const commandContext = action.mode === "blocked" ? "Not recommended" : action.mode === "mutating" ? "Manual terminal only" : (action.copyLabel ?? "Copy command");
    return `<article class="action-card" data-mode="${escapeAttr(action.mode)}" data-safety="${escapeAttr(action.safety)}">
      <div class="action-head">
        <div><h4>${escapeHtml(action.title)}</h4><p>${escapeHtml(action.rationale)}</p></div>
        <div class="action-badges">${badge(action.category)}${badge(action.mode)}${badge(action.safety)}${badge(action.source)}</div>
      </div>
      ${action.command ? `<div class="command-preview"><div><strong>${escapeHtml(commandContext)}</strong>${action.mode === "mutating" ? "<span>UI execution disabled</span>" : ""}</div><pre>${escapeHtml(action.command)}</pre>${action.mode === "blocked" ? "" : `<button type="button" data-copy-command="${escapeAttr(action.command)}">${escapeHtml(action.copyLabel ?? "copy command")}</button>`}</div>` : ""}
      <div class="action-fields">
        ${action.workingDirectory ? actionList("Working directory", [action.workingDirectory]) : ""}
        ${actionList("Reads", action.reads)}
        ${actionList("Writes", action.writes)}
        ${actionList("Expected evidence", action.expectedEvidence)}
        ${actionList("Preconditions", action.preconditions)}
        ${actionList("Blockers", action.blockers)}
        ${actionList("Warnings", action.warnings)}
      </div>
    </article>`;
  }).join("");
  return `<div class="action-previews"><div class="section-title"><h3>Action Previews</h3><span>Preview only; no actions execute in the UI</span></div>${cards || "<p>No action previews were generated.</p>"}</div>`;
}

function actionList(title: string, values: string[] | undefined): string {
  if (!values?.length) return "";
  return `<div><h5>${escapeHtml(title)}</h5><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul></div>`;
}

function settingsSection(data: AdminData): string {
  return `<section id="settings">
    <div class="section-title"><h2>Settings</h2><span>${data.configExists ? "config loaded" : "using defaults"}</span></div>
    <div class="notice">
      Local-only config editor. It writes only the admin config path when served by <code>pnpm dev admin serve</code>; it never shows env var values, calls providers, mutates repos, applies patches, or deploys.
    </div>
    <dl class="settings">
      <dt>Config path</dt><dd><code>${escapeHtml(data.configPath)}</code></dd>
      <dt>Run roots</dt><dd><code>${escapeHtml(data.settings.defaultRoots.join(", "))}</code></dd>
      <dt>Redaction policy</dt><dd>${escapeHtml(data.settings.redactionPolicy)}</dd>
      <dt>Save behavior</dt><dd>Save is enabled only through the localhost admin server. Static file mode still supports editing, validation, and redacted diff preview.</dd>
    </dl>
    <div class="editor-actions">
      <button type="button" id="settings-reset">Reset draft</button>
      <button type="button" id="settings-validate">Validate draft</button>
      <button type="button" id="settings-diff">Preview diff</button>
      <button type="button" id="settings-save" disabled>Save local config</button>
      <span id="settings-save-state">Detecting writable server...</span>
    </div>
    <h3>Repositories</h3>
    <table class="edit-table"><thead><tr><th>ID</th><th>Name</th><th>Path</th><th>Tags</th><th>Status</th><th></th></tr></thead><tbody id="repo-editor"></tbody></table>
    <button type="button" id="repo-add">Add repository</button>
    <h3>Providers</h3>
    <table class="edit-table"><thead><tr><th>ID</th><th>Type</th><th>Enabled</th><th>apiKeyRef</th><th>Default model</th><th>Command</th><th>Status</th><th></th></tr></thead><tbody id="provider-editor"></tbody></table>
    <button type="button" id="provider-add">Add provider</button>
    <h3>Run Roots</h3>
    <table class="edit-table"><thead><tr><th>Root</th><th>Status</th><th></th></tr></thead><tbody id="root-editor"></tbody></table>
    <button type="button" id="root-add">Add run root</button>
    <div class="diagnostics">
      <h3>Validation Diagnostics</h3>
      <ul id="settings-diagnostics"></ul>
    </div>
    <div class="diff-preview">
      <h3>Diff Preview</h3>
      <ul id="settings-diff-summary"></ul>
      <pre id="settings-diff-json"></pre>
    </div>
  </section>`;
}

function adminCss(): string {
  return `:root{color-scheme:light;--ink:#18201f;--muted:#62706c;--line:#d7dfdc;--panel:#f7f9f6;--paper:#fff;--accent:#1f6f5b;--warn:#a44922;--danger:#8f1f1f;--ok:#316d3f;--amber:#fff8ea;--red:#fff1f1}*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#eef3ef}header{display:grid;grid-template-columns:minmax(280px,1fr) minmax(420px,720px);gap:24px;padding:28px 32px;background:#fbfcfa;border-bottom:1px solid var(--line)}h1{margin:0;font-size:34px;letter-spacing:0}h2{margin:0;font-size:20px}h3{margin:18px 0 8px;font-size:15px}h4{margin:0 0 4px;font-size:15px}h5{margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase}.eyebrow{margin:0 0 4px;color:var(--accent);font-weight:700;text-transform:uppercase;font-size:12px}.lede{margin:8px 0 0;color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.metrics div,section{background:var(--paper);border:1px solid var(--line);border-radius:8px}.metrics div{padding:12px}.metrics dt{color:var(--muted);font-size:12px}.metrics dd{margin:2px 0 0;font-size:22px;font-weight:700}main{padding:18px 32px 40px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;position:sticky;top:0;z-index:2;background:#eef3ef;padding:8px 0}nav a,.filters button,button{border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:7px 10px;color:var(--ink);text-decoration:none}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}section{padding:18px;margin:0 0 18px;overflow:hidden}.section-title{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:14px}.section-title span{color:var(--muted)}.split{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.overview-facts{margin:0 0 14px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:700;white-space:nowrap}td small{display:block;color:var(--muted);margin-top:2px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;background:var(--panel);font-size:12px;margin:1px 2px 1px 0;white-space:nowrap}.badge[data-kind*="verified"],.badge[data-kind="present"],.badge[data-kind="clean"],.badge[data-kind="exists"],.badge[data-kind="ok"],.badge[data-kind="safe"],.badge[data-kind="read_only"],.badge[data-kind="safety_safe"]{border-color:#aac9b1;color:var(--ok);background:#f1f8f2}.badge[data-kind*="failed"],.badge[data-kind*="rejected"],.badge[data-kind="missing"],.badge[data-kind="dirty"],.badge[data-kind="do_not_apply"],.badge[data-kind="invalid"],.badge[data-kind="urgent"],.badge[data-kind*="unsafe"],.badge[data-kind="blocked"],.badge[data-kind="danger"],.badge[data-kind="mutating"],.badge[data-kind="safety_blocked"],.badge[data-kind="safety_danger"]{border-color:#d8aa95;color:var(--warn);background:#fff6f1}.badge[data-kind="caution"],.badge[data-kind="dry_run"],.badge[data-kind="safety_caution"]{border-color:#d8c38c;color:#7b5b12;background:#fff8ea}.filters,.editor-actions,.compare-controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.filters input,.filters select,.compare-controls select,.edit-table input,.edit-table select{border:1px solid var(--line);border-radius:6px;background:#fff;padding:8px 10px;min-width:140px}.filters input{min-width:280px}.edit-table input,.edit-table select{width:100%}.edit-table td{min-width:120px}.edit-table td:nth-child(3){min-width:240px}.runs-table{display:block;overflow:auto;max-width:100%;font-size:13px}.runs-table tbody tr{background:#fff}.urgent-row{background:var(--amber)}.action-cell{display:block;min-width:150px}.action-cell small{max-width:210px}.path-control{display:grid;grid-template-columns:minmax(180px,1fr) auto auto;gap:4px;align-items:center;min-width:220px;max-width:420px}.path-link{overflow-wrap:anywhere;font-size:12px}.path-copy,.path-open{padding:4px 7px;font-size:12px}.missing-path{color:var(--muted)}details{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:700;display:flex;gap:8px;align-items:center;justify-content:space-between}summary span{color:var(--ink);font-weight:700}summary small{color:var(--muted);font-weight:400}.summary-card{display:grid;grid-template-columns:minmax(220px,1fr) minmax(420px,2fr);gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}.summary-card.unsafe{background:var(--red);border-color:#dfb4a8}.summary-card h3{margin:0 0 4px}.summary-card p{margin:0;color:var(--muted)}.summary-card dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.summary-card dt{color:var(--muted);font-size:12px}.summary-card dd{margin:0;font-weight:700;overflow-wrap:anywhere}.graph{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;list-style:none;padding:0}.graph li{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel);min-height:94px}.graph li[data-status*="fail"],.graph li[data-status*="reject"]{background:#fff6f1;border-color:#d8aa95}.graph span{display:block;color:var(--accent)}.graph small{color:var(--muted);overflow-wrap:anywhere}.artifact-list{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;margin:10px 0;overflow:auto}.artifact-list h3{margin-top:0}.action-previews{margin:12px 0}.action-card{border:1px solid var(--line);background:#fff;border-radius:8px;padding:12px;margin:10px 0}.action-card[data-mode="blocked"],.action-card[data-safety="blocked"]{background:#fff6f1;border-color:#d8aa95}.action-card[data-mode="mutating"]{background:#fff8ea;border-color:#d8c38c}.action-head{display:grid;grid-template-columns:minmax(260px,1fr) minmax(220px,auto);gap:10px}.action-head p{margin:0;color:var(--muted)}.action-badges{text-align:right}.command-preview{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;margin:10px 0;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start}.command-preview div{grid-column:1/-1;display:flex;gap:8px;align-items:center;color:var(--muted)}.command-preview pre{grid-column:1;margin:0;max-height:160px}.command-preview button{grid-column:2;white-space:nowrap}.action-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.action-fields ul{margin:0;padding-left:18px}.action-fields li{overflow-wrap:anywhere}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.detail-grid>div,.notice,.diagnostics,.diff-preview,.compare-output{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}.notice{margin-bottom:12px}pre{white-space:pre-wrap;overflow:auto;font-size:12px;max-height:300px}.settings{display:grid;grid-template-columns:160px 1fr;gap:8px}.settings dt{color:var(--muted)}.hidden{display:none}.diagnostics ul,.diff-preview ul{margin:0;padding-left:18px}.diagnostic-error{color:var(--danger);font-weight:700}.diagnostic-warning{color:var(--warn)}.diagnostic-info{color:var(--muted)}.changed{background:#fff8ea}.compare-output table{background:#fff}@media(max-width:900px){header{grid-template-columns:1fr;padding:22px 18px}.metrics,.split,.summary-card,.summary-card dl,.action-head,.command-preview{grid-template-columns:1fr}.action-badges{text-align:left}.command-preview button{grid-column:1}main{padding:14px 18px}table{display:block;overflow:auto}.settings{grid-template-columns:1fr}.filters input{min-width:180px}.path-control{grid-template-columns:1fr}}`;
}

function adminJs(): string {
  return `const adminData=JSON.parse(document.getElementById('admin-data').textContent);const rows=[...document.querySelectorAll('.run-row')];const runsById=Object.fromEntries((adminData.runs||[]).map((run)=>[run.id,run]));const search=document.getElementById('run-search');const repo=document.getElementById('repo-filter');const outcome=document.getElementById('outcome-filter');const provider=document.getElementById('provider-filter');const alpha=document.getElementById('alpha-filter');const packet=document.getElementById('packet-filter');const operator=document.getElementById('operator-filter');const mutation=document.getElementById('mutation-filter');const sort=document.getElementById('sort-filter');const visible=document.getElementById('visible-runs');const body=document.getElementById('runs-body');const activeQuick={value:''};function valueId(v){return String(v||'').split('|')[0]}function findDetail(id){return [...document.querySelectorAll('.run-detail')].find((detail)=>detail.getAttribute('data-detail-id')===id)}window.openRunDetailById=(id)=>{const detail=findDetail(id);if(detail){detail.open=true;detail.scrollIntoView({behavior:'smooth',block:'start'})}};async function copyText(value){try{await navigator.clipboard.writeText(value);return true}catch{}try{const ta=document.createElement('textarea');ta.value=value;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok}catch{return false}}function rowMatchesQuick(row){const q=activeQuick.value;if(!q)return true;if(q==='urgent')return row.dataset.urgent==='true';if(q==='do_not_apply')return row.dataset.dna==='true';if(q==='provider_rejected')return row.dataset.providerRejected==='true';if(q==='verification_failed')return row.dataset.verificationFailed==='true';if(q==='setup')return row.dataset.setup==='true';if(q==='proposal')return row.dataset.proposal==='true';if(q==='verified')return row.dataset.verified==='true';if(q==='viewer')return row.dataset.viewer==='true';if(q==='summary')return row.dataset.summary==='true';if(q==='action_safe')return row.dataset.actionSafe==='true';if(q==='action_caution')return row.dataset.actionCaution==='true';if(q==='action_blocked')return row.dataset.actionBlocked==='true';if(q==='action_mutating')return row.dataset.actionMutating==='true';if(q==='action_none')return row.dataset.actionNone==='true';return true}function compareForSort(a,b){const mode=sort?.value||'newest';if(mode==='outcome')return a.dataset.outcome.localeCompare(b.dataset.outcome)||newest(a,b);if(mode==='repo')return a.dataset.repo.localeCompare(b.dataset.repo)||newest(a,b);if(mode==='alpha')return a.dataset.alpha.localeCompare(b.dataset.alpha,undefined,{numeric:true})||newest(a,b);if(mode==='provider')return a.dataset.provider.localeCompare(b.dataset.provider)||newest(a,b);return newest(a,b)}function newest(a,b){return (Date.parse(b.dataset.updated||'')||0)-(Date.parse(a.dataset.updated||'')||0)}function apply(){const q=(search?.value||'').toLowerCase();let count=0;const sorted=[...rows].sort(compareForSort);sorted.forEach((row)=>body?.appendChild(row));for(const row of sorted){const text=row.textContent.toLowerCase();const show=(!q||text.includes(q))&&(!repo.value||row.dataset.repo===repo.value)&&(!outcome.value||row.dataset.outcome===outcome.value)&&(!provider.value||row.dataset.provider===provider.value)&&(!alpha.value||row.dataset.alpha===alpha.value)&&(!packet.value||row.dataset.packetType===packet.value)&&(!operator.value||row.dataset.operator===operator.value)&&(!mutation.value||row.dataset.mutation===mutation.value)&&rowMatchesQuick(row);row.classList.toggle('hidden',!show);if(show)count++;}if(visible)visible.textContent=String(count)}for(const el of [search,repo,outcome,provider,alpha,packet,operator,mutation,sort])el&&el.addEventListener('input',apply);document.querySelectorAll('[data-quick]').forEach((button)=>button.addEventListener('click',()=>{activeQuick.value=activeQuick.value===button.dataset.quick?'':button.dataset.quick;document.querySelectorAll('[data-quick]').forEach((b)=>b.toggleAttribute('aria-pressed',b.dataset.quick===activeQuick.value));apply()}));document.getElementById('reset-filters')?.addEventListener('click',()=>{for(const el of [search,repo,outcome,provider,alpha,packet,operator,mutation])if(el)el.value='';if(sort)sort.value='newest';activeQuick.value='';document.querySelectorAll('[data-quick]').forEach((b)=>b.removeAttribute('aria-pressed'));apply()});document.addEventListener('click',async(e)=>{const b=e.target;if(b?.dataset?.copyPath){b.textContent=await copyText(b.dataset.copyPath)?'copied':'selected';setTimeout(()=>{b.textContent='copy'},1200)}if(b?.dataset?.copyCommand){b.textContent=await copyText(b.dataset.copyCommand)?'copied':'selected';setTimeout(()=>{b.textContent='copy command'},1200)}if(b?.dataset?.openDetail){window.openRunDetailById(b.dataset.openDetail)}});function setCompareFromChecks(){const picked=[...document.querySelectorAll('.compare-pick:checked')].map((el)=>el.value).slice(-2);document.querySelectorAll('.compare-pick').forEach((el)=>{if(picked.length>=2&&!picked.includes(el.value))el.checked=false});if(picked[0])document.getElementById('compare-left').value=picked[0]+'|';if(picked[1])document.getElementById('compare-right').value=picked[1]+'|';renderCompare()}document.querySelectorAll('.compare-pick').forEach((el)=>el.addEventListener('change',setCompareFromChecks));for(const el of [document.getElementById('compare-left'),document.getElementById('compare-right')])el?.addEventListener('input',renderCompare);document.getElementById('compare-clear')?.addEventListener('click',()=>{document.getElementById('compare-left').value='';document.getElementById('compare-right').value='';document.querySelectorAll('.compare-pick').forEach((el)=>{el.checked=false});renderCompare()});function renderCompare(){const left=runsById[valueId(document.getElementById('compare-left')?.value)];const right=runsById[valueId(document.getElementById('compare-right')?.value)];const out=document.getElementById('compare-output');if(!out)return;if(!left||!right){out.textContent='Select two runs to compare key fields.';return}const fields=[['Repo','repo'],['Alpha','alpha'],['Scenario','scenario'],['Outcome','outcome'],['Provider status','providerStatus'],['Safety flags','safetyFlags'],['Action count','actionSummary.count'],['Action safety','actionSummary.highestSafety'],['Recommended action','actionSummary.recommendedTitle'],['Mutation verdict','mutationVerdict'],['Operator verdict','operatorVerdict'],['Setup status','setupStatus'],['Proposal status','proposalStatus'],['Command count','commandCount'],['Artifact count','artifactCount'],['Packet path','packetPath'],['Summary path','summaryPath'],['Viewer path','viewerPath'],['Dashboard path','dashboardPath']];let changed=0;const get=(obj,path)=>path.split('.').reduce((acc,key)=>acc?.[key],obj);const rowsHtml=fields.map(([label,key])=>{const lraw=get(left,key);const rraw=get(right,key);const lv=Array.isArray(lraw)?(lraw.join(', ')||'none'):String(lraw??'unknown');const rv=Array.isArray(rraw)?(rraw.join(', ')||'none'):String(rraw??'unknown');const isChanged=lv!==rv;if(isChanged)changed++;return '<tr class="'+(isChanged?'changed':'')+'"><th>'+esc(label)+'</th><td>'+esc(lv)+'</td><td>'+esc(rv)+'</td><td>'+(isChanged?'changed':'same')+'</td></tr>'}).join('');out.innerHTML='<p>'+changed+' changed fields.</p><table><thead><tr><th>Field</th><th>Left</th><th>Right</th><th>Status</th></tr></thead><tbody>'+rowsHtml+'</tbody></table>'}apply();renderCompare();
let draft=structuredClone(adminData.settings.config);let writable=false;const repoBody=document.getElementById('repo-editor');const providerBody=document.getElementById('provider-editor');const rootBody=document.getElementById('root-editor');const diagnosticsEl=document.getElementById('settings-diagnostics');const saveButton=document.getElementById('settings-save');const saveState=document.getElementById('settings-save-state');function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}function splitTags(v){return String(v||'').split(',').map((x)=>x.trim()).filter(Boolean)}function renderEditor(){repoBody.innerHTML=draft.repositories.map((r,i)=>'<tr><td><input data-kind="repo" data-i="'+i+'" data-field="id" value="'+esc(r.id)+'"></td><td><input data-kind="repo" data-i="'+i+'" data-field="name" value="'+esc(r.name)+'"></td><td><input data-kind="repo" data-i="'+i+'" data-field="path" value="'+esc(r.path)+'"></td><td><input data-kind="repo" data-i="'+i+'" data-field="tags" value="'+esc((r.tags||[]).join(', '))+'"></td><td data-status="repo:'+esc(r.id)+'">pending</td><td><button type="button" data-remove-repo="'+i+'">Remove</button></td></tr>').join('');providerBody.innerHTML=draft.providers.map((p,i)=>'<tr><td><input data-kind="provider" data-i="'+i+'" data-field="id" value="'+esc(p.id)+'"></td><td><select data-kind="provider" data-i="'+i+'" data-field="type"><option '+(p.type==='openrouter'?'selected':'')+'>openrouter</option><option '+(p.type==='cli'?'selected':'')+'>cli</option><option '+(!['openrouter','cli'].includes(p.type)?'selected':'')+'>'+esc(p.type||'future')+'</option></select></td><td><input type="checkbox" data-kind="provider" data-i="'+i+'" data-field="enabled" '+(p.enabled?'checked':'')+'></td><td><input data-kind="provider" data-i="'+i+'" data-field="apiKeyRef" value="'+esc(p.apiKeyRef||'')+'"></td><td><input data-kind="provider" data-i="'+i+'" data-field="defaultModel" value="'+esc(p.defaultModel||'')+'"></td><td><input data-kind="provider" data-i="'+i+'" data-field="command" value="'+esc(p.command||'')+'"></td><td data-status="provider:'+esc(p.id)+'">pending</td><td><button type="button" data-remove-provider="'+i+'">Remove</button></td></tr>').join('');rootBody.innerHTML=draft.runs.defaultRoots.map((root,i)=>'<tr><td><input data-kind="root" data-i="'+i+'" value="'+esc(root)+'"></td><td data-status="root:'+i+'">pending</td><td><button type="button" data-remove-root="'+i+'">Remove</button></td></tr>').join('');}function collect(){document.querySelectorAll('[data-kind="repo"]').forEach((el)=>{const r=draft.repositories[Number(el.dataset.i)];if(el.dataset.field==='tags')r.tags=splitTags(el.value);else r[el.dataset.field]=el.value});document.querySelectorAll('[data-kind="provider"]').forEach((el)=>{const p=draft.providers[Number(el.dataset.i)];p[el.dataset.field]=el.type==='checkbox'?el.checked:(el.value||null)});document.querySelectorAll('[data-kind="root"]').forEach((el)=>{draft.runs.defaultRoots[Number(el.dataset.i)]=el.value});}function redacts(v){return JSON.stringify(v,null,2).replace(/sk-or-v1-[A-Za-z0-9._-]{8,}/gi,'[REDACTED_OPENROUTER_KEY]').replace(/Bearer\\s+[A-Za-z0-9._~+/=-]{8,}/gi,'Bearer [REDACTED]').replace(/(api[_-]?key|token|secret|password)(\\s*[:=]\\s*[\\"']?)[^\\"'\\s,;]{6,}/gi,'$1$2[REDACTED]')}function localValidate(){const ds=[];const ids={};draft.repositories.forEach((r,i)=>{if(!r.id)ds.push({level:'error',code:'repository_id_required',message:'Repository id is required.',path:'repositories.'+i+'.id'});ids[r.id]=(ids[r.id]||0)+1;if(!r.path)ds.push({level:'error',code:'repository_path_required',message:'Repository path is required.',path:'repositories.'+i+'.path'});});Object.keys(ids).forEach((id)=>{if(id&&ids[id]>1)ds.push({level:'error',code:'duplicate_repository_id',message:'Duplicate repository id: '+id,path:'repositories'});});const pids={};draft.providers.forEach((p,i)=>{if(!p.id)ds.push({level:'error',code:'provider_id_required',message:'Provider id is required.',path:'providers.'+i+'.id'});pids[p.id]=(pids[p.id]||0)+1;if(p.type==='openrouter'&&p.apiKeyRef&&!String(p.apiKeyRef).startsWith('env:'))ds.push({level:'error',code:'openrouter_api_key_ref_invalid',message:'OpenRouter apiKeyRef must be an env: reference.',path:'providers.'+i+'.apiKeyRef'});if(/sk-or-v1-|Bearer\\s+|api[_-]?key\\s*[:=]|token\\s*[:=]/i.test(String(p.apiKeyRef||'')))ds.push({level:'error',code:'provider_raw_token_rejected',message:'Provider token fields must contain references only.',path:'providers.'+i+'.apiKeyRef'});});Object.keys(pids).forEach((id)=>{if(id&&pids[id]>1)ds.push({level:'error',code:'duplicate_provider_id',message:'Duplicate provider id: '+id,path:'providers'});});const roots={};draft.runs.defaultRoots.forEach((r,i)=>{if(!r)ds.push({level:'error',code:'run_root_empty',message:'Run root must be non-empty.',path:'runs.defaultRoots.'+i});roots[r]=(roots[r]||0)+1});Object.keys(roots).forEach((root)=>{if(root&&roots[root]>1)ds.push({level:'warning',code:'duplicate_run_root',message:'Duplicate run root: '+root,path:'runs.defaultRoots'});});return {ok:!ds.some((d)=>d.level==='error'),diagnostics:ds,normalized:draft}}function renderDiagnostics(ds){diagnosticsEl.innerHTML=(ds.length?ds:[{level:'info',code:'ok',message:'No validation errors.',path:''}]).map((d)=>'<li class="diagnostic-'+esc(d.level)+'"><strong>'+esc(d.level)+' '+esc(d.code)+'</strong> '+esc(d.message)+(d.path?' <code>'+esc(d.path)+'</code>':'')+'</li>').join('')}async function validate(){collect();if(writable){const res=await fetch('/api/admin/config/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft})});const json=await res.json();renderDiagnostics(json.diagnostics||[]);renderStatus(json.status);return json}const res=localValidate();renderDiagnostics(res.diagnostics);return res}function renderStatus(status){if(!status)return;(status.repositories||[]).forEach((s)=>{const el=document.querySelector('[data-status="repo:'+CSS.escape(s.id)+'"]');if(el)el.textContent=(s.exists?'exists':'missing')+', '+(s.git?'git '+s.head:'not git')+', '+(s.clean===true?'clean':s.clean===false?'dirty':'unknown')});(status.providers||[]).forEach((s)=>{const el=document.querySelector('[data-status="provider:'+CSS.escape(s.id)+'"]');if(el)el.textContent=s.enabled?'enabled, '+s.tokenStatus:'disabled, '+s.tokenStatus});(status.runRoots||[]).forEach((s,i)=>{const el=document.querySelector('[data-status="root:'+i+'"]');if(el)el.textContent=(s.exists?'exists':'missing')+' '+s.absolutePath})}function localDiff(){const summary=[];const before=adminData.settings.config;const map=(xs)=>Object.fromEntries(xs.map((x)=>[x.id,x]));const br=map(before.repositories),ar=map(draft.repositories);Object.keys(ar).forEach((id)=>{if(!br[id])summary.push('Repository added: '+id);else if(JSON.stringify(br[id])!==JSON.stringify(ar[id]))summary.push('Repository changed: '+id)});Object.keys(br).forEach((id)=>{if(!ar[id])summary.push('Repository removed: '+id)});const bp=map(before.providers),ap=map(draft.providers);Object.keys(ap).forEach((id)=>{if(!bp[id])summary.push('Provider added: '+id);else if(JSON.stringify(bp[id])!==JSON.stringify(ap[id]))summary.push('Provider changed: '+id)});Object.keys(bp).forEach((id)=>{if(!ap[id])summary.push('Provider removed: '+id)});draft.runs.defaultRoots.filter((r)=>!before.runs.defaultRoots.includes(r)).forEach((r)=>summary.push('Run root added: '+r));before.runs.defaultRoots.filter((r)=>!draft.runs.defaultRoots.includes(r)).forEach((r)=>summary.push('Run root removed: '+r));return {summary:summary.length?summary:['No changes.'],json:redacts({before,after:draft})}}async function diff(){collect();let d;if(writable){const res=await fetch('/api/admin/config/diff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft})});d=(await res.json()).diff}else d=localDiff();document.getElementById('settings-diff-summary').innerHTML=d.summary.map((x)=>'<li>'+esc(x)+'</li>').join('');document.getElementById('settings-diff-json').textContent=d.json}document.getElementById('repo-add')?.addEventListener('click',()=>{collect();draft.repositories.push({id:'new-repo',name:'New repo',path:'',tags:[]});renderEditor()});document.getElementById('provider-add')?.addEventListener('click',()=>{collect();draft.providers.push({id:'new-provider',type:'cli',enabled:false,apiKeyRef:null,defaultModel:null,command:null});renderEditor()});document.getElementById('root-add')?.addEventListener('click',()=>{collect();draft.runs.defaultRoots.push('validation/runs');renderEditor()});document.getElementById('settings-reset')?.addEventListener('click',()=>{draft=structuredClone(adminData.settings.config);renderEditor();renderDiagnostics([]);document.getElementById('settings-diff-json').textContent='';document.getElementById('settings-diff-summary').innerHTML=''}) ;document.getElementById('settings-validate')?.addEventListener('click',validate);document.getElementById('settings-diff')?.addEventListener('click',diff);document.getElementById('settings-save')?.addEventListener('click',async()=>{const v=await validate();if(!v.ok){saveState.textContent='Save blocked by validation errors.';return}await diff();const res=await fetch('/api/admin/config/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft})});const json=await res.json();saveState.textContent=json.saved?'Saved '+json.configPath+(json.backupPath?' (backup '+json.backupPath+')':''):'Save blocked.'});document.addEventListener('click',(e)=>{const b=e.target;if(b?.dataset?.removeRepo!==undefined){collect();draft.repositories.splice(Number(b.dataset.removeRepo),1);renderEditor()}if(b?.dataset?.removeProvider!==undefined){collect();draft.providers.splice(Number(b.dataset.removeProvider),1);renderEditor()}if(b?.dataset?.removeRoot!==undefined){collect();draft.runs.defaultRoots.splice(Number(b.dataset.removeRoot),1);renderEditor()}});fetch('/api/admin/status').then((r)=>r.ok?r.json():null).then((s)=>{writable=Boolean(s&&s.localOnly);saveButton.disabled=!writable;saveState.textContent=writable?'Writable through localhost server.':'Static preview mode.'}).catch(()=>{saveState.textContent='Static preview mode.'});renderEditor();validate().catch(()=>{});`;
}

function metric(label: string, value: string | number): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

function countsTable(title: string, counts: Record<string, number>): string {
  const rows = Object.entries(counts).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value}</td></tr>`).join("");
  return `<div><h3>${escapeHtml(title)}</h3><table><tbody>${rows || "<tr><td>none</td><td>0</td></tr>"}</tbody></table></div>`;
}

function select(id: string, label: string, values: string[]): string {
  return `<select id="${escapeAttr(id)}" aria-label="${escapeAttr(label)}"><option value="">${escapeHtml(label)}: all</option>${values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("")}</select>`;
}

function jsonBlock(title: string, value: unknown): string {
  return `<div><details><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(value === null ? "not found" : JSON.stringify(value, null, 2))}</pre></details></div>`;
}

function badge(value: string): string {
  return `<span class="badge" data-kind="${escapeAttr(value)}">${escapeHtml(value)}</span>`;
}

function pathLink(path: string): string {
  if (!path || path === "unknown") return "unknown";
  return `<a class="path-link" href="file://${escapeAttr(path)}">${escapeHtml(path)}</a>`;
}

function pathControl(path: string, label: string, route?: string): string {
  if (!path || path === "unknown") return `<span class="missing-path">${escapeHtml(label)} unavailable</span>`;
  const href = route ?? `file://${path}`;
  return `<span class="path-control"><a class="path-link" href="${escapeAttr(href)}" title="${escapeAttr(label)}">${escapeHtml(path)}</a><button type="button" class="path-copy" data-copy-path="${escapeAttr(path)}">copy</button><a class="path-open" href="${escapeAttr(href)}">open</a></span>`;
}

function safetyFlags(flags: string[]): string {
  return flags.length ? flags.map((flag) => badge(flag)).join("") : badge("none");
}

function miniFact(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function dateShort(value: string): string {
  if (!value || value === "unknown") return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function runSelect(id: string, label: string, runs: AdminData["runs"]): string {
  return `<select id="${escapeAttr(id)}" aria-label="${escapeAttr(label)}"><option value="">${escapeHtml(label)}</option>${runs.map((run) => `<option value="${escapeAttr(run.id)}|">${escapeHtml(`${run.alpha} / ${run.repo} / ${run.scenario}`)}</option>`).join("")}</select>`;
}

function emptyRow(columns: number): string {
  return `<tr><td colspan="${columns}">none</td></tr>`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
