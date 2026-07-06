export function dashboardCss(): string {
  return `body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9;color:#18202a}header{background:#17212f;color:#fff;padding:28px 32px}main{padding:24px 32px}h1{margin:0;font-size:28px}h2{font-size:18px;margin:0 0 12px}.lede{max-width:860px;color:#d9e5f8}.eyebrow{margin:0 0 6px;color:#a7c7ff;text-transform:uppercase;font-size:12px}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0 0}.summary-grid div,section{background:#fff;color:#18202a;border:1px solid #d9dee7;border-radius:6px}.summary-grid div{padding:12px}.summary-grid dt{font-size:12px;color:#5c6675}.summary-grid dd{margin:4px 0 0;font-weight:700}.summary-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.summary-sections section{margin:0 0 16px}section{padding:16px;margin:0 0 16px;overflow:auto}.section-title{display:flex;gap:12px;align-items:center;justify-content:space-between}.filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.filter-grid label,.quick-actions label{display:grid;gap:5px;font-size:12px;font-weight:700;color:#4a5565}.filter-grid input,.filter-grid select,.quick-actions input{font:inherit;font-weight:400;padding:8px;border:1px solid #b7c0cd;border-radius:4px;background:#fff;color:#18202a}button{font:inherit;border:1px solid #9aa7b8;background:#eef2f7;border-radius:4px;padding:8px 10px;cursor:pointer}.quick-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-top:12px}.quick-actions label{flex:1 1 320px}.filter-status{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;color:#4a5565}.filter-status strong{color:#18202a}.muted{color:#647184}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e4e8ef;text-align:left;padding:8px;vertical-align:top}th{background:#eef2f7}.counts{max-width:820px}.summary-sections .counts{max-width:none}.record-list{margin:0;padding-left:18px}.record-list li{margin:6px 0}.record-list span,.label,.outcome{display:inline-block;background:#eef2f7;border:1px solid #d1d8e3;border-radius:4px;padding:2px 6px;margin:1px;color:#273142}.label-provider-rejected,.label-do-not-apply,.label-forbidden-path,.label-malformed-diff,.label-dry-run-apply-failed,.label-verification-failed,.outcome-provider-rejected,.outcome-verification-failed{background:#fff0f0;border-color:#d86a6a;color:#8a1f1f}.label-proposal-ready-verified,.outcome-proposal-ready-verified{background:#ecf8ee;border-color:#65a86d;color:#1d6b2b}.label-unchanged{background:#eef6ff;border-color:#76a9db;color:#1f5e8f}.danger-text{font-weight:700;color:#9f1d1d;text-transform:uppercase}.safe-text{font-weight:700;color:#236b2c}.record-danger td:first-child{border-left:4px solid #c73636}.record-ready td:first-child{border-left:4px solid #2e8a3e}.artifact{display:grid;gap:3px;min-width:190px}.artifact code{white-space:normal;overflow-wrap:anywhere;font-size:12px;color:#4a5565}.artifact-list{display:grid;gap:8px;margin:10px 0}.details-body{min-width:320px;max-width:760px}.details-body pre{background:#f3f5f8;border:1px solid #d9dee7;border-radius:4px;padding:10px;overflow:auto;max-height:360px}.empty-state{padding:12px;background:#fff8db;border:1px solid #e0c45d;border-radius:4px}.link-button,.sort-button{border:0;background:transparent;color:#0759b8;padding:0;text-align:left;text-decoration:underline}.sort-button{font-weight:700;color:#18202a}a{color:#0759b8}`;
}

export function dashboardJs(): string {
  return `(() => {
  const rows = [...document.querySelectorAll(".record-row")];
  const tbody = document.querySelector("#records-table tbody");
  const search = document.getElementById("dashboard-search");
  const filters = [
    ["outcome", document.getElementById("outcome-filter")],
    ["repo", document.getElementById("repo-filter")],
    ["scenario", null],
    ["providerStatus", document.getElementById("provider-status-filter")],
    ["mutationVerdict", document.getElementById("mutation-verdict-filter")],
    ["alpha", document.getElementById("alpha-filter")]
  ];
  const visibleRecords = document.getElementById("visible-records");
  const activeFilters = document.getElementById("active-filters");
  const emptyState = document.getElementById("empty-state");
  const currentViewUrl = document.getElementById("current-view-url");
  const copyStatus = document.getElementById("copy-current-view-status");
  let quickFilter = "";
  let scenarioFilter = "";
  let sortState = { key: "", direction: "asc" };
  function activeFilterInputs() {
    return filters.map(([key, input]) => [key, input ? input.value : scenarioFilter]);
  }
  function applyFilters(options = {}) {
    const query = search.value.trim().toLowerCase();
    const active = [];
    let visible = 0;
    for (const row of rows) {
      const matchesSearch = !query || row.dataset.search.includes(query);
      const matchesSelects = activeFilterInputs().every(([key, value]) => {
        if (!value) return true;
        return row.dataset[key] === value;
      });
      const matchesQuick = !quickFilter || (quickFilter === "verified" && row.dataset.outcome === "proposal_ready_verified") || (quickFilter === "unsafe" && row.dataset.unsafe === "true");
      const shown = matchesSearch && matchesSelects && matchesQuick;
      row.hidden = !shown;
      if (shown) visible += 1;
    }
    if (query) active.push("search: " + query);
    for (const [key, value] of activeFilterInputs()) {
      if (value) active.push(key + ": " + value);
    }
    if (quickFilter) active.push("quick: " + quickFilter);
    visibleRecords.textContent = String(visible);
    activeFilters.textContent = active.length ? active.join(", ") : "none";
    emptyState.hidden = visible !== 0;
    updateCurrentView(options.replaceHistory === true);
  }
  function readStateFromHash() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    search.value = params.get("q") || "";
    for (const [key, input] of filters) {
      const value = params.get(key) || "";
      if (input) input.value = value;
      if (key === "scenario") scenarioFilter = value;
    }
    quickFilter = params.get("quick") || "";
  }
  function updateCurrentView(replaceHistory) {
    const params = new URLSearchParams();
    if (search.value.trim()) params.set("q", search.value.trim());
    for (const [key, value] of activeFilterInputs()) {
      if (value) params.set(key, value);
    }
    if (quickFilter) params.set("quick", quickFilter);
    const hash = params.toString();
    const next = window.location.pathname + window.location.search + (hash ? "#" + hash : "");
    if (window.location.hash.replace(/^#/, "") !== hash) {
      if (replaceHistory) window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
    }
    currentViewUrl.value = window.location.href;
  }
  function setSelectFilter(key, value) {
    const entry = filters.find(([candidate]) => candidate === key);
    if (!entry) return;
    const input = entry[1];
    if (input) input.value = value;
    if (key === "scenario") scenarioFilter = value;
    quickFilter = "";
    applyFilters();
  }
  function copyCurrentView() {
    currentViewUrl.select();
    const value = currentViewUrl.value;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(() => {
        copyStatus.textContent = "Current view URL copied.";
      }).catch(() => {
        copyStatus.textContent = "Copy failed; use the current view URL field.";
      });
      return;
    }
    try {
      document.execCommand("copy");
      copyStatus.textContent = "Current view URL copied.";
    } catch {
      copyStatus.textContent = "Copy failed; use the current view URL field.";
    }
  }
  function sortRows(key) {
    const direction = sortState.key === key && sortState.direction === "asc" ? "desc" : "asc";
    sortState = { key, direction };
    const sorted = [...rows].sort((a, b) => {
      const left = a.dataset[key] || "";
      const right = b.dataset[key] || "";
      return direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
    });
    for (const row of sorted) tbody.appendChild(row);
  }
  search.addEventListener("input", () => applyFilters());
  for (const [, input] of filters) {
    if (input) input.addEventListener("change", () => {
      quickFilter = "";
      applyFilters();
    });
  }
  for (const button of document.querySelectorAll("[data-filter-key]")) {
    button.addEventListener("click", () => setSelectFilter(button.dataset.filterKey, button.dataset.filterValue));
  }
  for (const button of document.querySelectorAll("[data-quick-filter]")) {
    button.addEventListener("click", () => {
      quickFilter = button.dataset.quickFilter;
      applyFilters();
    });
  }
  for (const button of document.querySelectorAll("[data-sort]")) {
    button.addEventListener("click", () => sortRows(button.dataset.sort));
  }
  document.getElementById("copy-current-view").addEventListener("click", copyCurrentView);
  document.getElementById("reset-filters").addEventListener("click", () => {
    search.value = "";
    for (const [, input] of filters) if (input) input.value = "";
    scenarioFilter = "";
    quickFilter = "";
    applyFilters();
  });
  window.addEventListener("hashchange", () => {
    readStateFromHash();
    applyFilters({ replaceHistory: true });
  });
  readStateFromHash();
  applyFilters({ replaceHistory: true });
})();`;
}
