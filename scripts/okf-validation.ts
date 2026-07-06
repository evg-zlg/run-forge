import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportOkfBundle, validateOkfBundle } from "../src/run/okf-knowledge-export.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const out = await mkdtemp(join(tmpdir(), "runforge-okf-validation-"));
const bundle = join(out, "bundle");

await exportOkfBundle({ root: join(repo, "validation/runs"), out: bundle });
const result = await validateOkfBundle(bundle);

console.log(result.ok ? `OKF validation: passed (${result.files.length} markdown files)` : "OKF validation: failed");
for (const error of result.errors) console.log(`- ${error}`);
if (!result.ok) process.exitCode = 1;
