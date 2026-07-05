import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPacketIndex } from "../src/run/packet-indexer.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-10");
const indexPath = join(validationDir, "external-dogfood-index.json");
const outDir = "/tmp/runforge-alpha10-index-validation";

interface Alpha10Index {
  entries: Array<{
    scenario: string;
    outcome: string;
    providerStatus: string;
    patchTouchedFiles: string[];
    externalRepoHeadBefore: string | null;
    externalRepoHeadAfter: string | null;
    externalRepoMutationVerdict: string;
    decision: string;
    notes: string;
  }>;
}

const requiredFiles = [
  "summary.md",
  "results.json",
  "external-dogfood-index.json"
];

const missing: string[] = [];
for (const file of requiredFiles) {
  try {
    await access(join(validationDir, file));
  } catch {
    missing.push(file);
  }
}

const dogfood = JSON.parse(await readFile(indexPath, "utf8")) as Alpha10Index;
const scenarios = new Map(dogfood.entries.map((entry) => [entry.scenario, entry]));
const requiredScenarios = [
  "smartsql-readme-provider-proposal",
  "smartsql-env-provider-rejection",
  "smartsql-merge-intervals-real-code-proposal",
  "factory-readme-provider-rejection-dry-run-apply"
];

const errors = [...missing.map((file) => `missing ${file}`)];
for (const scenario of requiredScenarios) {
  if (!scenarios.has(scenario)) errors.push(`missing scenario ${scenario}`);
}

const factory = scenarios.get("factory-readme-provider-rejection-dry-run-apply");
if (factory) {
  if (factory.decision !== "comparison_only") errors.push("factory evidence must be comparison_only");
  if (factory.outcome !== "provider_rejected") errors.push("factory evidence must remain provider_rejected");
  if (!factory.notes.includes("dry-run apply")) errors.push("factory notes must mention dry-run apply");
}

const intervals = scenarios.get("smartsql-merge-intervals-real-code-proposal");
if (intervals) {
  if (intervals.decision !== "no_apply") errors.push("merge_intervals evidence must be no_apply");
  if (!intervals.patchTouchedFiles.includes("factory-lab/smoke-task-repo/src/intervals.py")) errors.push("merge_intervals touched file missing");
}

for (const entry of dogfood.entries) {
  if (entry.externalRepoMutationVerdict !== "unchanged") errors.push(`${entry.scenario} mutation verdict must be unchanged`);
  if (entry.externalRepoHeadBefore !== entry.externalRepoHeadAfter) errors.push(`${entry.scenario} head before/after mismatch`);
}

const packetIndex = await buildPacketIndex({ root: join(repo, "validation/runs"), out: outDir });
const indexedMilestones = new Set(packetIndex.entries.map((entry) => entry.milestone));
if (!indexedMilestones.has("ALPHA-9")) errors.push("packet index must include ALPHA-9 entries");
if (!indexedMilestones.has("ALPHA-10")) errors.push("packet index must include ALPHA-10 entries");
if (!packetIndex.entries.some((entry) => entry.outcome === "provider_rejected" && entry.providerStatus === "rejected")) {
  errors.push("packet index must include rejected provider evidence");
}

console.log("# RunForge Alpha-10 Validation");
console.log("");
console.log(`Evidence entries: ${dogfood.entries.length}`);
console.log(`Packet index entries: ${packetIndex.entries.length}`);
console.log(`Packet index output: ${outDir}`);
console.log("");
for (const entry of dogfood.entries) {
  console.log(`- ${entry.scenario}: ${entry.outcome}, provider=${entry.providerStatus}, decision=${entry.decision}, mutation=${entry.externalRepoMutationVerdict}`);
}

if (errors.length > 0) {
  console.log("");
  console.log("Validation errors:");
  for (const error of errors) console.log(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Alpha-10 evidence validation: passed");
}
