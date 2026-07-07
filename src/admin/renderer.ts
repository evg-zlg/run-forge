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
  return `:root{color-scheme:light;--ink:#18201f;--muted:#62706c;--line:#d7dfdc;--panel:#f7f9f6;--paper:#fff;--accent:#1f6f5b;--warn:#a44922;--danger:#8f1f1f;--ok:#316d3f}*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#eef3ef}header{display:grid;grid-template-columns:minmax(280px,1fr) minmax(420px,720px);gap:24px;padding:28px 32px;background:#fbfcfa;border-bottom:1px solid var(--line)}h1{margin:0;font-size:34px;letter-spacing:0}h2{margin:0;font-size:20px}h3{margin:18px 0 8px;font-size:15px}.eyebrow{margin:0 0 4px;color:var(--accent);font-weight:700;text-transform:uppercase;font-size:12px}.lede{margin:8px 0 0;color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.metrics div,section{background:var(--paper);border:1px solid var(--line);border-radius:8px}.metrics div{padding:12px}.metrics dt{color:var(--muted);font-size:12px}.metrics dd{margin:2px 0 0;font-size:22px;font-weight:700}main{padding:18px 32px 40px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}nav a,.filters button,button{border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:7px 10px;color:var(--ink);text-decoration:none}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}section{padding:18px;margin:0 0 18px}.section-title{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:14px}.section-title span{color:var(--muted)}.split{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.overview-facts{margin:0 0 14px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:700}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;background:var(--panel);font-size:12px}.badge[data-kind*="verified"],.badge[data-kind="present"],.badge[data-kind="clean"],.badge[data-kind="exists"]{border-color:#aac9b1;color:var(--ok);background:#f1f8f2}.badge[data-kind*="failed"],.badge[data-kind*="rejected"],.badge[data-kind="missing"],.badge[data-kind="dirty"],.badge[data-kind="do_not_apply"],.badge[data-kind="invalid"]{border-color:#d8aa95;color:var(--warn);background:#fff6f1}.filters,.editor-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.filters input,.filters select,.edit-table input,.edit-table select{border:1px solid var(--line);border-radius:6px;background:#fff;padding:8px 10px;min-width:120px;width:100%}.edit-table td{min-width:120px}.edit-table td:nth-child(3){min-width:240px}.path-link{overflow-wrap:anywhere}details{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:700}summary span{color:var(--muted);font-weight:400}.graph{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;list-style:none;padding:0}.graph li{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel)}.graph span{display:block;color:var(--accent)}.graph small{color:var(--muted);overflow-wrap:anywhere}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.detail-grid>div,.notice,.diagnostics,.diff-preview{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}.notice{margin-bottom:12px}pre{white-space:pre-wrap;overflow:auto;font-size:12px}.settings{display:grid;grid-template-columns:160px 1fr;gap:8px}.settings dt{color:var(--muted)}.hidden{display:none}.diagnostics ul,.diff-preview ul{margin:0;padding-left:18px}.diagnostic-error{color:var(--danger);font-weight:700}.diagnostic-warning{color:var(--warn)}.diagnostic-info{color:var(--muted)}@media(max-width:900px){header{grid-template-columns:1fr;padding:22px 18px}.metrics,.split{grid-template-columns:1fr}main{padding:14px 18px}table{display:block;overflow:auto}.settings{grid-template-columns:1fr}}`;
}

function adminJs(): string {
  return `const adminData=JSON.parse(document.getElementById('admin-data').textContent);const rows=[...document.querySelectorAll('.run-row')];const search=document.getElementById('run-search');const repo=document.getElementById('repo-filter');const outcome=document.getElementById('outcome-filter');const provider=document.getElementById('provider-filter');const alpha=document.getElementById('alpha-filter');const visible=document.getElementById('visible-runs');function apply(){const q=(search?.value||'').toLowerCase();let count=0;for(const row of rows){const text=row.textContent.toLowerCase();const show=(!q||text.includes(q))&&(!repo.value||row.dataset.repo===repo.value)&&(!outcome.value||row.dataset.outcome===outcome.value)&&(!provider.value||row.dataset.provider===provider.value)&&(!alpha.value||row.dataset.alpha===alpha.value);row.classList.toggle('hidden',!show);if(show)count++;}if(visible)visible.textContent=String(count)}for(const el of [search,repo,outcome,provider,alpha])el&&el.addEventListener('input',apply);document.querySelectorAll('[data-quick]').forEach((button)=>button.addEventListener('click',()=>{const quick=button.dataset.quick;repo.value='';outcome.value='';provider.value='';alpha.value='';search.value='';rows.forEach((row)=>{const show=quick==='do_not_apply'?row.dataset.dna==='true':quick==='verified'?row.dataset.verified==='true':row.dataset.setup==='true';row.classList.toggle('hidden',!show)});if(visible)visible.textContent=String(rows.filter((row)=>!row.classList.contains('hidden')).length)}));document.getElementById('reset-filters')?.addEventListener('click',()=>{search.value='';repo.value='';outcome.value='';provider.value='';alpha.value='';apply()});apply();
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
