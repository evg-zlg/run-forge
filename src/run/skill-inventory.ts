import { homedir } from "node:os";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { findSecretLikeContent } from "./okf-secret-scan.js";

export interface SkillInventoryOptions {
  out: string;
  roots?: string[];
}

export interface SkillInventoryItem {
  name: string;
  path: string;
  description: string;
  trigger: string;
  fileCount: number;
  sizeBytes: number;
  status: "active" | "unknown" | "stale_candidate" | "duplicate_candidate";
  notes: string[];
}

export interface SkillInventoryResult {
  generatedAt: string;
  inspectedRoots: string[];
  skills: SkillInventoryItem[];
  missingRoots: string[];
  jsonPath: string;
  markdownPath: string;
}

export async function buildSkillInventory(options: SkillInventoryOptions): Promise<SkillInventoryResult> {
  const out = resolve(options.out);
  const roots = options.roots ?? defaultSkillRoots();
  const missingRoots: string[] = [];
  const skills: SkillInventoryItem[] = [];
  for (const root of roots.map((item) => resolve(item))) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      missingRoots.push(root);
      continue;
    }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      skills.push(await inspectSkill(join(root, entry.name)));
    }
  }

  const duplicateNames = new Set(skills.map((skill) => skill.name).filter((name, _, names) => names.indexOf(name) !== names.lastIndexOf(name)));
  const normalized = skills.map((skill) => duplicateNames.has(skill.name) ? { ...skill, status: "duplicate_candidate" as const, notes: [...skill.notes, "Same skill name appears in multiple locations."] } : skill);
  const result = {
    generatedAt: new Date().toISOString(),
    inspectedRoots: roots.map((item) => resolve(item)),
    skills: normalized,
    missingRoots,
    jsonPath: join(out, "skills-inventory.json"),
    markdownPath: join(out, "skills-inventory.md")
  };

  await mkdir(out, { recursive: true });
  await writeFile(result.jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(result.markdownPath, renderSkillInventory(result), "utf8");
  return result;
}

export function renderSkillInventory(result: SkillInventoryResult): string {
  const lines = [
    "# RunForge Skills Inventory",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Summary",
    "",
    `Inspected roots: ${result.inspectedRoots.length}`,
    `Skills found: ${result.skills.length}`,
    `Missing roots: ${result.missingRoots.length}`,
    "",
    "## Missing Roots",
    "",
    ...((result.missingRoots.length > 0 ? result.missingRoots : ["none"]).map((root) => `- ${root}`)),
    "",
    "## Skills",
    "",
    "| Name | Status | Files | Size | Description |",
    "| --- | --- | ---: | ---: | --- |",
    ...result.skills.map((skill) => `| ${cell(skill.name)} | ${skill.status} | ${skill.fileCount} | ${skill.sizeBytes} | ${cell(skill.description || "unknown")} |`),
    "",
    "## Lifecycle Notes",
    "",
    "This report is inventory only. It does not create, delete, or promote skills."
  ];
  return `${lines.join("\n")}\n`;
}

function defaultSkillRoots(): string[] {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return [".agents/skills", join(codexHome, "skills")];
}

async function inspectSkill(path: string): Promise<SkillInventoryItem> {
  const files = await collectFiles(path);
  const skillMd = files.find((file) => basename(file).toLowerCase() === "skill.md");
  const content = skillMd ? await readFile(skillMd, "utf8").catch(() => "") : "";
  const description = extractDescription(content);
  const trigger = extractTrigger(content);
  const notes = skillMd ? skillNotes(content, description, trigger) : ["No SKILL.md file found."];
  return {
    name: basename(path),
    path,
    description,
    trigger,
    fileCount: files.length,
    sizeBytes: await totalSize(files),
    status: skillMd ? "active" : "unknown",
    notes
  };
}

async function collectFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return collectFiles(child);
    return Promise.resolve(entry.isFile() ? [child] : []);
  }));
  return nested.flat();
}

async function totalSize(files: string[]): Promise<number> {
  const sizes = await Promise.all(files.map((file) => stat(file).then((info) => info.size).catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function extractDescription(content: string): string {
  const line = content.split(/\r?\n/).find((item) => /^description\s*:/i.test(item));
  if (line) return line.replace(/^description\s*:\s*/i, "").trim();
  return content.split(/\r?\n/).find((item) => item.trim() && !item.startsWith("#"))?.trim() ?? "";
}

function extractTrigger(content: string): string {
  const line = content.split(/\r?\n/).find((item) => /trigger/i.test(item));
  return line?.replace(/^[-*\s#]*/, "").trim() ?? "";
}

function skillNotes(content: string, description: string, trigger: string): string[] {
  const notes: string[] = [];
  if (!/Evidence:|Source Evidence|validation\/runs|summary\.md|results\.json/i.test(content)) notes.push("missing evidence links");
  if (/\b(?:obsolete|retired|superseded)\b[\s\S]{0,80}\bALPHA-(?:[1-9]|1[0-6])\b/i.test(content)) notes.push("mentions obsolete Alpha milestones");
  for (const pattern of findSecretLikeContent(content)) notes.push(`secret-like pattern ${pattern}`);
  if (description.split(/\s+/).filter(Boolean).length < 5 && trigger.split(/\s+/).filter(Boolean).length < 5) notes.push("too vague to act on safely");
  const evidence = content.match(/(?:validation\/runs|summary\.md|results\.json)[^\s)`,]*/g) ?? [];
  if (evidence.length > 0) notes.push(`Evidence: ${[...new Set(evidence)].join(", ")}`);
  return notes;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
