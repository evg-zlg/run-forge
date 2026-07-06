import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportOkfBundle, validateOkfBundle } from "../src/run/okf-knowledge-export.js";
import { buildSkillCuratorReport } from "../src/run/skill-curator-report.js";
import { buildSkillInventory } from "../src/run/skill-inventory.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = join(repo, "validation/runs");
const temp = await mkdtemp(join(tmpdir(), "runforge-alpha17-"));
const errors: string[] = [];

const okf = await exportOkfBundle({ root: runs, out: join(temp, "okf") });
const okfValidation = await validateOkfBundle(okf.out);
check(okfValidation.ok, `OKF validation failed: ${okfValidation.errors.join("; ")}`);
check(okf.files.includes("index.md"), "OKF index.md not generated");
check(okf.files.includes("log.md"), "OKF log.md not generated");
check(okf.files.includes("milestones/alpha-16.md"), "Alpha-16 milestone page not generated");
check(okf.files.includes("concepts/setup-preflight.md"), "setup/preflight concept missing");
check(okf.files.includes("concepts/provider-rejected.md"), "provider-rejected concept missing");

const inventory = await buildSkillInventory({ out: join(temp, "skills"), roots: [join(temp, "missing-skills")] });
check(inventory.skills.length === 0, "missing skill roots should not fabricate skills");
check(inventory.missingRoots.length === 1, "missing skill root should be reported");

const curator = await buildSkillCuratorReport({ runs, out: join(temp, "curator") });
const candidateNames = new Set(curator.candidates.map((candidate) => candidate.name));
check(candidateNames.has("setup-preflight-diagnosis"), "setup/preflight candidate missing");
check(candidateNames.has("provider-patch-review"), "provider patch review candidate missing");
check((await readFile(curator.markdownPath, "utf8")).includes("human/PR review"), "curator report must require human/PR review");

console.log(renderSummary());
if (errors.length > 0) process.exitCode = 1;

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function renderSummary(): string {
  return [
    "# RunForge Alpha-17 Validation",
    "",
    `Evidence root: ${runs}`,
    `Temporary output: ${temp}`,
    `OKF files: ${okf.files.length}`,
    `Curator candidates: ${curator.candidates.length}`,
    "",
    errors.length === 0 ? "Alpha-17 validation: passed" : "Alpha-17 validation: failed",
    ...errors.map((error) => `- ${error}`)
  ].join("\n");
}
