import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const validationDir = join(repo, "validation/runs/ALPHA-9");
const resultsPath = join(validationDir, "results.json");

interface Alpha9Attempt {
  id: string;
  repo: string;
  decision: string;
  packet: string;
  viewer: string;
  inspectValidate: string;
  inspectMermaid: string;
}

interface Alpha9Results {
  schemaVersion: string;
  generatedAt: string;
  attempts: Alpha9Attempt[];
  validation: Array<{ command: string; status: string; notes?: string }>;
}

const results = JSON.parse(await readFile(resultsPath, "utf8")) as Alpha9Results;

const requiredFiles = [
  "summary.md",
  "results.json",
  "external-dogfood/smartsql-readme-proposal/task.md",
  "external-dogfood/smartsql-readme-proposal/source-repo.md",
  "external-dogfood/smartsql-readme-proposal/packet-paths.md",
  "external-dogfood/smartsql-readme-proposal/decision.md",
  "external-dogfood/smartsql-readme-proposal/provider-audit.md",
  "external-dogfood/smartsql-readme-proposal/viewer-paths.md",
  "external-dogfood/smartsql-readme-proposal/validation.md",
  "external-dogfood/smartsql-readme-proposal/applied-patch-if-any.patch",
  "external-dogfood/smartsql-readme-proposal/post-apply-validation-if-any.md",
  "external-dogfood/smartsql-provider-reject/task.md",
  "external-dogfood/smartsql-provider-reject/source-repo.md",
  "external-dogfood/smartsql-provider-reject/packet-paths.md",
  "external-dogfood/smartsql-provider-reject/decision.md",
  "external-dogfood/smartsql-provider-reject/provider-audit.md",
  "external-dogfood/smartsql-provider-reject/viewer-paths.md",
  "external-dogfood/smartsql-provider-reject/validation.md",
  "external-dogfood/smartsql-provider-reject/applied-patch-if-any.patch",
  "external-dogfood/smartsql-provider-reject/post-apply-validation-if-any.md"
];

const missing: string[] = [];
for (const file of requiredFiles) {
  try {
    await access(join(validationDir, file));
  } catch {
    missing.push(file);
  }
}

console.log("# RunForge Alpha-9 Dogfood Summary");
console.log("");
console.log(`Generated at: ${results.generatedAt}`);
console.log(`Schema: ${results.schemaVersion}`);
console.log("");
for (const attempt of results.attempts) {
  console.log(`- ${attempt.id}: ${attempt.decision}`);
  console.log(`  repo: ${attempt.repo}`);
  console.log(`  packet: ${attempt.packet}`);
  console.log(`  viewer: ${attempt.viewer}`);
}
console.log("");
console.log("Validation:");
for (const item of results.validation) {
  console.log(`- ${item.status.toUpperCase()} ${item.command}${item.notes ? ` - ${item.notes}` : ""}`);
}
if (missing.length > 0) {
  console.log("");
  console.log("Missing evidence files:");
  for (const file of missing) console.log(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Evidence file check: passed");
}
