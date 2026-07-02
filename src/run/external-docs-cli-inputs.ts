import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface ExternalDocsTextInputOptions {
  anchor?: string;
  anchorFile?: string;
  insert?: string;
  insertFile?: string;
  rationale?: string;
  rationaleFile?: string;
}

export interface ResolvedExternalDocsTextInputs {
  anchor: string;
  insert: string;
  rationale: string;
}

export async function resolveExternalDocsTextInputs(
  options: ExternalDocsTextInputOptions
): Promise<ResolvedExternalDocsTextInputs> {
  validateTextSource("--anchor", options.anchor, "--anchor-file", options.anchorFile, true);
  validateTextSource("--insert", options.insert, "--insert-file", options.insertFile, true);
  validateTextSource("--rationale", options.rationale, "--rationale-file", options.rationaleFile, false);
  return {
    anchor: options.anchorFile ? await readCliTextFile(options.anchorFile, "--anchor-file") : options.anchor ?? "",
    insert: options.insertFile ? await readCliTextFile(options.insertFile, "--insert-file") : options.insert ?? "",
    rationale: options.rationaleFile
      ? await readCliTextFile(options.rationaleFile, "--rationale-file")
      : options.rationale ?? "Docs proposal requested from CLI flags."
  };
}

function validateTextSource(directFlag: string, directValue: string | undefined, fileFlag: string, fileValue: string | undefined, required: boolean): void {
  if (directValue !== undefined && fileValue !== undefined) throw new Error(`${directFlag} and ${fileFlag} are mutually exclusive.`);
  if (required && directValue === undefined && fileValue === undefined) throw new Error(`${directFlag} or ${fileFlag} is required.`);
}

async function readCliTextFile(path: string, field: string): Promise<string> {
  const fullPath = resolve(path);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) throw new Error(`${field} path is not a file: ${path}`);
    return await readFile(fullPath, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a file")) throw error;
    throw new Error(`${field} file does not exist: ${path}`);
  }
}
