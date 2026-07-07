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
      <a href="#settings">Settings</a>
    </nav>
    ${overviewSection(data)}
    ${repositoriesSection(data)}
    ${providersSection(data)}
    ${runsSection(data)}
    ${detailsSection(data)}
    ${settingsSection(data)}
  </main>
  <script id="admin-data" type="application/json">${payload}</script>
  <script>${adminJs()}</script>
</body>
</html>
`;
}

function overviewSection(data: AdminData): string {
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
  const rows = data.runs.map((run) => `<tr class="run-row" data-repo="${escapeAttr(run.repo)}" data-outcome="${escapeAttr(run.outcome)}" data-provider="${escapeAttr(run.providerStatus)}" data-alpha="${escapeAttr(run.alpha)}" data-dna="${run.doNotApply}" data-verified="${run.verifiedProposal}" data-setup="${run.setupFailure}">
    <td>${escapeHtml(run.alpha)}</td><td>${escapeHtml(run.repo)}</td><td>${escapeHtml(run.scenario)}</td><td>${escapeHtml(run.packetType)}</td>
    <td>${badge(run.outcome)}</td><td>${badge(run.providerStatus)}</td><td>${escapeHtml(run.operatorVerdict)}</td><td>${escapeHtml(run.mutationVerdict)}</td>
    <td>${pathLink(run.packetPath)}</td><td>${pathLink(run.viewerPath)}</td><td>${pathLink(run.summaryPath)}</td>
  </tr>`).join("");
  return `<section id="runs">
    <div class="section-title"><h2>Runs / Evidence</h2><span><strong id="visible-runs">${data.runs.length}</strong> visible</span></div>
    <div class="filters">
      <input id="run-search" type="search" placeholder="Search repo, scenario, outcome">
      ${select("repo-filter", "Repo", unique(data.runs.map((run) => run.repo)))}
      ${select("outcome-filter", "Outcome", unique(data.runs.map((run) => run.outcome)))}
      ${select("provider-filter", "Provider", unique(data.runs.map((run) => run.providerStatus)))}
      ${select("alpha-filter", "Alpha", unique(data.runs.map((run) => run.alpha)))}
      <button type="button" data-quick="do_not_apply">do_not_apply</button>
      <button type="button" data-quick="verified">verified</button>
      <button type="button" data-quick="setup">setup failures</button>
      <button type="button" id="reset-filters">reset</button>
    </div>
    <table><thead><tr><th>Alpha</th><th>Repo</th><th>Scenario</th><th>Packet type</th><th>Outcome</th><th>Provider</th><th>Operator</th><th>Mutation</th><th>Packet</th><th>Viewer</th><th>Summary</th></tr></thead><tbody>${rows || emptyRow(11)}</tbody></table>
  </section>`;
}

function detailsSection(data: AdminData): string {
  const items = data.runDetails.map((detail) => `<details>
    <summary>${escapeHtml(detail.packetPath)} <span>${detail.graph.length} graph nodes</span></summary>
    <p>${escapeHtml(detail.summary)}</p>
    <ol class="graph">${detail.graph.map((node) => `<li><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.status)}</span><small>${escapeHtml(node.detail)}</small></li>`).join("")}</ol>
    <div class="detail-grid">
      ${jsonBlock("Metrics", detail.metrics)}
      ${jsonBlock("Safety", detail.safety)}
      ${jsonBlock("Setup policy", detail.setupPolicy)}
      ${jsonBlock("Provider audit", detail.providerAudit)}
      ${jsonBlock("Proposal status", detail.proposalStatus)}
      <div><h3>Artifacts</h3><ul>${detail.artifacts.map((artifact) => `<li>${escapeHtml(artifact)}</li>`).join("") || "<li>none</li>"}</ul></div>
    </div>
  </details>`).join("");
  return `<section id="details"><div class="section-title"><h2>Run Detail / Graph</h2><span>${data.runDetails.length} loaded</span></div>${items || "<p>No packet details were available.</p>"}</section>`;
}

function settingsSection(data: AdminData): string {
  return `<section id="settings">
    <div class="section-title"><h2>Settings</h2><span>${data.configExists ? "config loaded" : "using defaults"}</span></div>
    <dl class="settings">
      <dt>Config path</dt><dd><code>${escapeHtml(data.configPath)}</code></dd>
      <dt>Run roots</dt><dd><code>${escapeHtml(data.settings.defaultRoots.join(", "))}</code></dd>
      <dt>Redaction policy</dt><dd>${escapeHtml(data.settings.redactionPolicy)}</dd>
      <dt>Write behavior</dt><dd>Static UI is read-only. Use <code>pnpm dev admin config</code>, <code>repo add</code>, and <code>provider add-*</code> for local config writes.</dd>
    </dl>
  </section>`;
}

function adminCss(): string {
  return `:root{color-scheme:light;--ink:#18201f;--muted:#62706c;--line:#d7dfdc;--panel:#f7f9f6;--paper:#fff;--accent:#1f6f5b;--warn:#a44922;--ok:#316d3f}*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#eef3ef}header{display:grid;grid-template-columns:minmax(280px,1fr) minmax(420px,720px);gap:24px;padding:28px 32px;background:#fbfcfa;border-bottom:1px solid var(--line)}h1{margin:0;font-size:34px;letter-spacing:0}h2{margin:0;font-size:20px}.eyebrow{margin:0 0 4px;color:var(--accent);font-weight:700;text-transform:uppercase;font-size:12px}.lede{margin:8px 0 0;color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.metrics div,section{background:var(--paper);border:1px solid var(--line);border-radius:8px}.metrics div{padding:12px}.metrics dt{color:var(--muted);font-size:12px}.metrics dd{margin:2px 0 0;font-size:22px;font-weight:700}main{padding:18px 32px 40px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}nav a,.filters button{border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:7px 10px;color:var(--ink);text-decoration:none}section{padding:18px;margin:0 0 18px}.section-title{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:14px}.section-title span{color:var(--muted)}.split{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.overview-facts{margin:0 0 14px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:700}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;background:var(--panel);font-size:12px}.badge[data-kind*="verified"],.badge[data-kind="present"],.badge[data-kind="clean"],.badge[data-kind="exists"]{border-color:#aac9b1;color:var(--ok);background:#f1f8f2}.badge[data-kind*="failed"],.badge[data-kind*="rejected"],.badge[data-kind="missing"],.badge[data-kind="dirty"],.badge[data-kind="do_not_apply"]{border-color:#d8aa95;color:var(--warn);background:#fff6f1}.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.filters input,.filters select{border:1px solid var(--line);border-radius:6px;background:#fff;padding:8px 10px;min-width:170px}.path-link{overflow-wrap:anywhere}details{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:700}summary span{color:var(--muted);font-weight:400}.graph{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;list-style:none;padding:0}.graph li{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel)}.graph span{display:block;color:var(--accent)}.graph small{color:var(--muted);overflow-wrap:anywhere}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.detail-grid>div{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}pre{white-space:pre-wrap;overflow:auto;font-size:12px}.settings{display:grid;grid-template-columns:160px 1fr;gap:8px}.settings dt{color:var(--muted)}.hidden{display:none}@media(max-width:900px){header{grid-template-columns:1fr;padding:22px 18px}.metrics,.split{grid-template-columns:1fr}main{padding:14px 18px}table{display:block;overflow:auto}}`;
}

function adminJs(): string {
  return `const rows=[...document.querySelectorAll('.run-row')];const search=document.getElementById('run-search');const repo=document.getElementById('repo-filter');const outcome=document.getElementById('outcome-filter');const provider=document.getElementById('provider-filter');const alpha=document.getElementById('alpha-filter');const visible=document.getElementById('visible-runs');function apply(){const q=(search?.value||'').toLowerCase();let count=0;for(const row of rows){const text=row.textContent.toLowerCase();const show=(!q||text.includes(q))&&(!repo.value||row.dataset.repo===repo.value)&&(!outcome.value||row.dataset.outcome===outcome.value)&&(!provider.value||row.dataset.provider===provider.value)&&(!alpha.value||row.dataset.alpha===alpha.value);row.classList.toggle('hidden',!show);if(show)count++;}if(visible)visible.textContent=String(count)}for(const el of [search,repo,outcome,provider,alpha])el&&el.addEventListener('input',apply);document.querySelectorAll('[data-quick]').forEach((button)=>button.addEventListener('click',()=>{const quick=button.dataset.quick;repo.value='';outcome.value='';provider.value='';alpha.value='';search.value='';rows.forEach((row)=>{const show=quick==='do_not_apply'?row.dataset.dna==='true':quick==='verified'?row.dataset.verified==='true':row.dataset.setup==='true';row.classList.toggle('hidden',!show)});if(visible)visible.textContent=String(rows.filter((row)=>!row.classList.contains('hidden')).length)}));document.getElementById('reset-filters')?.addEventListener('click',()=>{search.value='';repo.value='';outcome.value='';provider.value='';alpha.value='';apply()});apply();`;
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
  return `<div><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(value === null ? "not found" : JSON.stringify(value, null, 2))}</pre></div>`;
}

function badge(value: string): string {
  return `<span class="badge" data-kind="${escapeAttr(value)}">${escapeHtml(value)}</span>`;
}

function pathLink(path: string): string {
  if (!path || path === "unknown") return "unknown";
  return `<a class="path-link" href="file://${escapeAttr(path)}">${escapeHtml(path)}</a>`;
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
