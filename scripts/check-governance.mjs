import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const requiredDocs = [
  "docs/engineering-rules.md",
  "docs/dogfooding.md",
  "docs/git-worktree-rules.md",
  "docs/report-contract.md",
  "docs/security-model.md",
  "validation/README.md"
];

const requiredScripts = ["check:git-safety", "check:governance", "check:structure", "validation:run", "dogfood", "dogfood:rails"];
const validationSources = new Set(["real", "fixture", "placeholder"]);
const scopeRoots = ["src", "scripts"];
const scopeExclusions = new Set(["scripts/check-governance.mjs"]);
const scopeTerms = [
  "saas",
  "hosted mode",
  "byoc",
  "dashboard",
  "auto-fix",
  "autofix",
  "persona reviewer",
  "persona reviewers",
  "marketplace",
  "billing",
  "self-improvement"
];

let failed = false;

for (const doc of requiredDocs) {
  if (!existsSync(doc)) fail(`Missing governance document: ${doc}`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const script of requiredScripts) {
  if (!pkg.scripts?.[script]) fail(`Missing package script: ${script}`);
}

await checkValidationCases();
await checkScopeCreep();

if (failed) process.exit(1);
console.log("Governance check passed.");

async function checkValidationCases() {
  const casesDir = "validation/cases";
  const entries = await readdir(casesDir, { withFileTypes: true });
  const caseDirs = entries
    .filter((entry) => entry.isDirectory() && /^case-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (caseDirs.length === 0) fail("Validation must include at least one case.");

  for (const caseId of caseDirs) {
    const caseDir = join(casesDir, caseId);
    for (const file of ["input.log", "metadata.json", "human-diagnosis.md", "expected-next-command.md"]) {
      if (!existsSync(join(caseDir, file))) fail(`Missing validation file: ${join(caseDir, file)}`);
    }

    const metadata = JSON.parse(await readFile(join(caseDir, "metadata.json"), "utf8"));
    if (metadata.caseId !== caseId) fail(`${caseId}: metadata.caseId must match directory name.`);
    if (!validationSources.has(metadata.source)) fail(`${caseId}: source must be real, fixture, or placeholder.`);
    if (metadata.source === "placeholder" && !metadata.placeholderReason?.trim()) {
      fail(`${caseId}: placeholder cases must include placeholderReason.`);
    }
    if (metadata.source !== "placeholder" && "placeholderReason" in metadata) {
      fail(`${caseId}: only placeholder cases may include placeholderReason.`);
    }
    checkScores(caseId, metadata.initialScore);
  }
}

function checkScores(caseId, scores) {
  for (const key of ["rootCause", "evidence", "safeNextCommand", "honestyCheckedNotChecked"]) {
    if (!Number.isInteger(scores?.[key]) || scores[key] < 0 || scores[key] > 3) {
      fail(`${caseId}: initialScore.${key} must be an integer from 0 to 3.`);
    }
  }
  if (!["pass", "fail"].includes(scores?.security)) {
    fail(`${caseId}: initialScore.security must be pass or fail.`);
  }
}

async function checkScopeCreep() {
  const files = (await Promise.all(scopeRoots.map((root) => collect(root)))).flat()
    .filter((file) => !scopeExclusions.has(file));
  files.push("package.json");

  for (const file of files) {
    let text = (await readFile(file, "utf8")).toLowerCase();
    text = text
      .replaceAll("dashboard-seed", "")
      .replaceAll("dashboard seed", "")
      .replaceAll("dashboardseed", "");
    for (const term of scopeTerms) {
      if (text.includes(term)) fail(`${file}: forbidden MVP scope term found: ${term}`);
    }
  }
}

async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return collect(child);
    if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)) return [child];
    return [];
  }));
  return nested.flat();
}

function fail(message) {
  failed = true;
  console.error(`FAIL ${message}`);
}
