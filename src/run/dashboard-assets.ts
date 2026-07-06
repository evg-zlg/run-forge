export function dashboardCss(): string {
  return `body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9;color:#18202a}header{background:#17212f;color:#fff;padding:28px 32px}main{padding:24px 32px}h1{margin:0;font-size:28px}h2{font-size:18px;margin:0 0 12px}.lede{max-width:860px;color:#d9e5f8}.eyebrow{margin:0 0 6px;color:#a7c7ff;text-transform:uppercase;font-size:12px}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0 0}.summary-grid div,section{background:#fff;color:#18202a;border:1px solid #d9dee7;border-radius:6px}.summary-grid div{padding:12px}.summary-grid dt{font-size:12px;color:#5c6675}.summary-grid dd{margin:4px 0 0;font-weight:700}section{padding:16px;margin:0 0 16px;overflow:auto}.section-title{display:flex;gap:12px;align-items:center;justify-content:space-between}.filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.filter-grid label{display:grid;gap:5px;font-size:12px;font-weight:700;color:#4a5565}.filter-grid input,.filter-grid select{font:inherit;font-weight:400;padding:8px;border:1px solid #b7c0cd;border-radius:4px;background:#fff;color:#18202a}button{font:inherit;border:1px solid #9aa7b8;background:#eef2f7;border-radius:4px;padding:8px 10px;cursor:pointer}.filter-status{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;color:#4a5565}.filter-status strong{color:#18202a}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e4e8ef;text-align:left;padding:8px;vertical-align:top}th{background:#eef2f7}.counts{max-width:620px}.record-list{margin:0;padding-left:18px}.record-list li{margin:6px 0}.record-list span,.label,.outcome{display:inline-block;background:#eef2f7;border:1px solid #d1d8e3;border-radius:4px;padding:2px 6px;margin:1px;color:#273142}.label-provider-rejected,.label-do-not-apply,.label-forbidden-path,.label-malformed-diff,.label-dry-run-apply-failed,.label-verification-failed,.outcome-provider-rejected,.outcome-verification-failed{background:#fff0f0;border-color:#d86a6a;color:#8a1f1f}.label-proposal-ready-verified,.outcome-proposal-ready-verified{background:#ecf8ee;border-color:#65a86d;color:#1d6b2b}.label-unchanged{background:#eef6ff;border-color:#76a9db;color:#1f5e8f}.danger-text{font-weight:700;color:#9f1d1d;text-transform:uppercase}.safe-text{font-weight:700;color:#236b2c}.record-danger td:first-child{border-left:4px solid #c73636}.record-ready td:first-child{border-left:4px solid #2e8a3e}.artifact{display:grid;gap:3px;min-width:190px}.artifact code{white-space:normal;overflow-wrap:anywhere;font-size:12px;color:#4a5565}.artifact-list{display:grid;gap:8px;margin:10px 0}.details-body{min-width:320px;max-width:760px}.details-body pre{background:#f3f5f8;border:1px solid #d9dee7;border-radius:4px;padding:10px;overflow:auto;max-height:360px}.empty-state{padding:12px;background:#fff8db;border:1px solid #e0c45d;border-radius:4px}a{color:#0759b8}`;
}

export function dashboardJs(): string {
  return `(() => {
  const rows = [...document.querySelectorAll(".record-row")];
  const search = document.getElementById("dashboard-search");
  const filters = [
    ["outcome", document.getElementById("outcome-filter")],
    ["repo", document.getElementById("repo-filter")],
    ["providerStatus", document.getElementById("provider-status-filter")],
    ["mutationVerdict", document.getElementById("mutation-verdict-filter")],
    ["alpha", document.getElementById("alpha-filter")]
  ];
  const visibleRecords = document.getElementById("visible-records");
  const activeFilters = document.getElementById("active-filters");
  const emptyState = document.getElementById("empty-state");
  function applyFilters() {
    const query = search.value.trim().toLowerCase();
    const active = [];
    let visible = 0;
    for (const row of rows) {
      const matchesSearch = !query || row.dataset.search.includes(query);
      const matchesSelects = filters.every(([key, input]) => {
        if (!input.value) return true;
        return row.dataset[key] === input.value;
      });
      const shown = matchesSearch && matchesSelects;
      row.hidden = !shown;
      if (shown) visible += 1;
    }
    if (query) active.push("search: " + query);
    for (const [key, input] of filters) {
      if (input.value) active.push(key + ": " + input.value);
    }
    visibleRecords.textContent = String(visible);
    activeFilters.textContent = active.length ? active.join(", ") : "none";
    emptyState.hidden = visible !== 0;
  }
  search.addEventListener("input", applyFilters);
  for (const [, input] of filters) input.addEventListener("change", applyFilters);
  document.getElementById("reset-filters").addEventListener("click", () => {
    search.value = "";
    for (const [, input] of filters) input.value = "";
    applyFilters();
  });
  applyFilters();
})();`;
}
