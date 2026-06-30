import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const WARN_AT = 300;
const FAIL_AT = 350;
const TARGET = 250;
const roots = ["src"];
const excluded = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)fixtures\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /\.log$/,
  /lock(?:file)?\./,
  /\.md$/
];

const files = (await Promise.all(roots.map((root) => collect(root)))).flat();
let failed = false;

for (const file of files) {
  if (excluded.some((rule) => rule.test(file))) continue;
  const lineCount = (await readFile(file, "utf8")).split(/\r?\n/).length;
  if (lineCount > FAIL_AT) {
    failed = true;
    console.error(`FAIL ${file}: ${lineCount} lines (limit ${FAIL_AT}, target ${TARGET})`);
  } else if (lineCount > WARN_AT) {
    console.warn(`WARN ${file}: ${lineCount} lines (warning ${WARN_AT}, target ${TARGET})`);
  }
}

if (failed) process.exit(1);
console.log(`Structure check passed for ${files.length} source files. Target <= ${TARGET} lines.`);

async function collect(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return collect(child);
    if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) return [child];
    return [];
  }));
  return nested.flat();
}
