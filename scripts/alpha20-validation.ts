import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildKnowledgeLifecycleReport, renderLifecycleSummary } from "../src/run/knowledge-lifecycle.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = join(repo, "validation/runs");
const out = join(runs, "ALPHA-20");
const trackedSkillRoots = [join(repo, ".agents/skills")];
const errors: string[] = [];
const commands = [
  "pnpm dev knowledge lifecycle-report --runs ./validation/runs --out ./validation/runs/ALPHA-20 --skill-root ./.agents/skills",
  "pnpm dev skills lifecycle-report --runs ./validation/runs --out /tmp/runforge-demo-skill-lifecycle",
  "pnpm demo:knowledge-lifecycle"
];

const report = await buildKnowledgeLifecycleReport({ repoRoot: repo, runs, out, skillRoots: trackedSkillRoots });

check(report.validation.ok, `lifecycle validation failed: ${report.validation.errors.join("; ")}`);
check(report.sourceCounts.okfFiles > 0, "OKF files should be indexed");
check(report.sourceCounts.validationRuns > 0, "validation runs should be indexed");
check(report.evidenceLinks.some((link) => link.includes("ALPHA-17") || link.includes("ALPHA-19")), "Alpha-17 or Alpha-19 evidence should be linked");
check(report.safetySummary.networkRequired === false, "lifecycle report must not require network");
check(report.safetySummary.providerCalls === false, "lifecycle report must not use providers");
await expectFile(join(out, "lifecycle-report.json"));
await expectFile(join(out, "summary.md"));

const summary = [
  renderLifecycleSummary(report).trimEnd(),
  "",
  "## Commands Run",
  "",
  ...commands.map((command) => `- ${command}`),
  "",
  "## Source Artifacts Inspected",
  "",
  `- ${report.sources.runs}`,
  `- ${report.sources.okfBundle}`,
  `- ${report.sources.skillsInventory}`,
  `- ${report.sources.curatorReport}`,
  "",
  "## Fixes Applied",
  "",
  "- Added deterministic OKF/skills lifecycle status model.",
  "- Added lifecycle report/index CLI surfaces.",
  "- Extended OKF validation and skill curator findings.",
  "",
  "## Limitations",
  "",
  "- Lifecycle links are local filesystem paths only.",
  "- Duplicate/overlap checks are deterministic heuristics, not semantic review.",
  "- Tracked Alpha-20 evidence scans repo-local skill roots only; local operator skill inventory remains a `/tmp` demo output to avoid committing personal skill names.",
  "",
  errors.length === 0 ? "Alpha-20 validation: passed" : "Alpha-20 validation: failed",
  ...errors.map((error) => `- ${error}`)
].join("\n") + "\n";

await writeFile(join(out, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

async function expectFile(path: string): Promise<void> {
  await access(path).catch(() => check(false, `missing expected file ${path}`));
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { validation?: { ok?: boolean } };
    check(parsed.validation?.ok === true, `${path} should record passing validation`);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}
