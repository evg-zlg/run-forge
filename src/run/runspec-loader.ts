import { dirname, resolve } from "node:path";
import { readText } from "../core/artifact-store.js";
import type { RunSpec } from "../core/types.js";
import { normalizeRunSpecDocument } from "./runspec-schema.js";

export async function loadRunSpecFile(path: string): Promise<RunSpec> {
  const specPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(specPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read RunSpec JSON at ${specPath}: ${message}`);
  }
  return normalizeRunSpecDocument(parsed, dirname(specPath));
}
