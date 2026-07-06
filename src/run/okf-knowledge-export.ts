import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { hasFrontmatterWithType, renderMarkdown, type Frontmatter } from "./markdown-frontmatter.js";
import { findSecretLikeContent } from "./okf-secret-scan.js";

export interface OkfExportOptions {
  root: string;
  out: string;
}

export interface OkfExportResult {
  out: string;
  files: string[];
}

interface EvidenceFile {
  milestone: string;
  summary?: string;
  results?: string;
  decisions?: string;
}

const concepts = [
  ["provider-rejected", "Provider Rejected", "Provider patch rejected by RunForge safety checks.", ["provider", "safety"], ["ALPHA-9", "ALPHA-15"]],
  ["proposal-ready-verified", "Proposal Ready Verified", "Failure evidence is strong enough for a bounded code proposal.", ["readiness", "proposal"], ["ALPHA-11"]],
  ["verification-failed", "Verification Failed", "A command or packet verification path failed and needs operator review.", ["verification"], ["PACKET-VALIDATION"]],
  ["do-not-apply", "Do Not Apply", "Operator decision to leave original repositories untouched.", ["operator", "safety"], ["ALPHA-15"]],
  ["packet-validation", "Packet Validation", "RunForge packet artifacts are validated as durable evidence.", ["packet", "validation"], ["PACKET-VALIDATION", "ALPHA-16"]],
  ["external-operator-trial", "External Operator Trial", "Dogfood evidence from operating RunForge against external repositories.", ["dogfood", "external"], ["ALPHA-15"]],
  ["setup-preflight", "Setup Preflight", "Explicit setup commands run in disposable workspaces before main checks.", ["setup", "preflight"], ["ALPHA-16"]],
  ["dependency-missing", "Dependency Missing", "Missing dependencies are environment context, not source-code proposal readiness.", ["dependency", "readiness"], ["ALPHA-15", "ALPHA-16"]],
  ["environment-error", "Environment Error", "Infrastructure or setup failures require context before code proposals.", ["environment", "triage"], ["ALPHA-15", "ALPHA-16"]]
] as const;

const playbooks = [
  ["external-dogfood-trial", "External Dogfood Trial", "Run packet-producing trials against disposable external workspaces.", ["dogfood", "packet"]],
  ["provider-patch-review", "Provider Patch Review", "Review provider proposals through safety reports before apply decisions.", ["provider", "review"]],
  ["manual-patch-acceptance", "Manual Patch Acceptance", "Require human review before applying generated patches.", ["manual", "safety"]],
  ["setup-preflight-check", "Setup Preflight Check", "Use setup commands to separate dependency preparation from source verification.", ["setup", "preflight"]]
] as const;

export async function exportOkfBundle(options: OkfExportOptions): Promise<OkfExportResult> {
  const root = resolve(options.root);
  const out = resolve(options.out);
  const evidence = await collectEvidence(root);
  const files: string[] = [];

  await mkdir(out, { recursive: true });
  await writePage(out, files, "index.md", fm("RunForge Knowledge Bundle", "RunForge OKF-compatible evidence export.", ["runforge", "okf"]), indexBody(evidence));
  await writePage(out, files, "log.md", fm("RunForge Knowledge Export Log", "Generated source evidence log.", ["runforge", "evidence"]), logBody(root, evidence));

  for (const item of evidence.filter((entry) => /^ALPHA-(?:9|1[0-6])$/.test(entry.milestone))) {
    const slug = item.milestone.toLowerCase();
    await writePage(out, files, `milestones/${slug}.md`, fm(`${item.milestone} ${milestoneTitle(item.milestone)}`, `RunForge ${item.milestone} validation evidence.`, ["runforge", slug]), milestoneBody(item));
  }
  for (const repo of ["smartsql", "factory"]) {
    await writePage(out, files, `repos/${repo}.md`, fm(`${titleCase(repo)} Repository Evidence`, `External repository evidence references for ${repo}.`, ["runforge", "repo", repo]), repoBody(repo, evidence));
  }
  for (const [slug, title, description, tags, milestones] of concepts) {
    await writePage(out, files, `concepts/${slug}.md`, fm(title, description, ["runforge", ...tags]), conceptBody(title, milestones));
  }
  for (const [slug, title, description, tags] of playbooks) {
    await writePage(out, files, `playbooks/${slug}.md`, fm(title, description, ["runforge", ...tags]), playbookBody(title));
  }
  await writePage(out, files, "decisions/alpha-15-factory-trial.md", fm("Factory Trial Environment Failure", "Missing dependencies in disposable workspace should not be treated as proposal-ready typecheck failure.", ["runforge", "factory", "environment", "readiness"]), decisionBody("ALPHA-15"));
  await writePage(out, files, "decisions/alpha-16-setup-preflight.md", fm("Alpha-16 Setup Preflight", "Setup commands run only in disposable workspaces and gate main commands by default.", ["runforge", "alpha-16", "setup", "preflight"]), decisionBody("ALPHA-16"));
  await writePage(out, files, "skill-candidates/index.md", fm("Skill Candidate Index", "Candidate operational skills derived from RunForge evidence.", ["runforge", "skills", "lifecycle"]), skillCandidateBody());

  return { out, files };
}

export async function validateOkfBundle(bundle: string): Promise<{ ok: boolean; errors: string[]; files: string[] }> {
  const root = resolve(bundle);
  const files = (await collectMarkdown(root)).sort();
  const errors: string[] = [];
  for (const required of ["index.md", "log.md", "concepts", "playbooks", "milestones"]) {
    if (!files.some((file) => file === required || file.startsWith(`${required}/`))) errors.push(`missing ${required}`);
  }
  for (const file of files) {
    const content = await readFile(join(root, file), "utf8");
    if (!hasFrontmatterWithType(content)) errors.push(`${file} missing frontmatter type`);
    for (const pattern of findSecretLikeContent(content)) errors.push(`${file} contains secret-like pattern ${pattern}`);
  }
  return { ok: errors.length === 0, errors, files };
}

async function collectEvidence(root: string): Promise<EvidenceFile[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => {
    const dir = join(root, entry.name);
    return { milestone: entry.name, summary: join(dir, "summary.md"), results: join(dir, "results.json"), decisions: join(dir, "operator-decisions.md") };
  }).sort((a, b) => a.milestone.localeCompare(b.milestone, undefined, { numeric: true }));
}

async function writePage(out: string, files: string[], file: string, frontmatter: Frontmatter, body: string): Promise<void> {
  const content = renderMarkdown(frontmatter, `${body}\n\n_Generated RunForge knowledge export. Review source evidence before operational use._`);
  const secretMatches = findSecretLikeContent(content);
  if (secretMatches.length > 0) throw new Error(`Refusing to write ${file}: secret-like content matched ${secretMatches.join(", ")}`);
  await mkdir(join(out, basename(file) === file ? "" : file.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(join(out, file), content, "utf8");
  files.push(file);
}

function fm(title: string, description: string, tags: string[]): Frontmatter {
  return { type: inferType(title), title, description, tags, generated: true };
}

function inferType(title: string): string {
  if (title.includes("Alpha") || title.includes("ALPHA")) return "RunForge Milestone";
  if (title.includes("Decision") || title.includes("Factory Trial")) return "RunForge Decision";
  if (title.includes("Playbook") || title.includes("Check") || title.includes("Review")) return "RunForge Playbook";
  return "RunForge Concept";
}

function indexBody(evidence: EvidenceFile[]): string {
  return `# RunForge Knowledge Bundle\n\n## Summary\nPortable markdown and frontmatter export for packet evidence, milestones, concepts, decisions, and skill candidates.\n\n## Source Evidence\n${evidence.map((item) => `- [${item.milestone}](milestones/${item.milestone.toLowerCase()}.md)`).join("\n")}\n\n## Sections\n- [Log](log.md)\n- [Skill candidates](skill-candidates/index.md)\n- [Setup preflight](concepts/setup-preflight.md)\n- [Provider rejected](concepts/provider-rejected.md)\n\n## Safety Notes\nOKF is an export layer only. Packets and dashboards remain the runtime source of truth.`;
}

function logBody(root: string, evidence: EvidenceFile[]): string {
  return `# Export Log\n\n## Summary\nGenerated from validation evidence under \`${root}\`.\n\n## Evidence References\n${evidence.map((item) => `- ${item.milestone}: \`${item.summary}\`, \`${item.results}\``).join("\n")}`;
}

function milestoneBody(item: EvidenceFile): string {
  return `# ${item.milestone}\n\n## Summary\nMilestone evidence exported from RunForge validation records.\n\n## Source Evidence\n- Summary: \`${item.summary}\`\n- Results: \`${item.results}\`${item.decisions ? `\n- Decisions: \`${item.decisions}\`` : ""}\n\n## Related Concepts\n- [Packet validation](../concepts/packet-validation.md)\n- [Provider rejected](../concepts/provider-rejected.md)\n- [Setup preflight](../concepts/setup-preflight.md)\n\n## Safety Notes\nThis page references evidence paths and concise outcomes only; raw logs are not copied.`;
}

function repoBody(repo: string, evidence: EvidenceFile[]): string {
  const refs = evidence.filter((item) => repo === "factory" ? item.milestone === "ALPHA-15" : /^ALPHA-(9|1[0-4])$/.test(item.milestone));
  return `# ${titleCase(repo)} Evidence\n\n## Summary\nRepository-facing dogfood evidence references for ${repo}.\n\n## Source Evidence\n${refs.map((item) => `- ${item.milestone}: \`${item.summary}\``).join("\n") || "- No direct local evidence found."}\n\n## Safety Notes\nExternal repositories are referenced for review only and are not mutated by this export.`;
}

function conceptBody(title: string, milestones: readonly string[]): string {
  return `# ${title}\n\n## Summary\nOperational knowledge distilled from RunForge packet and validation evidence.\n\n## Source Evidence\n${milestones.map((milestone) => `- [${milestone}](../milestones/${milestone.toLowerCase()}.md)`).join("\n")}\n\n## Related Playbooks\n- [Provider patch review](../playbooks/provider-patch-review.md)\n- [Setup preflight check](../playbooks/setup-preflight-check.md)\n\n## Safety Notes\nTreat this as reviewable knowledge, not an instruction to mutate repositories.`;
}

function playbookBody(title: string): string {
  return `# ${title}\n\n## Summary\nA lightweight operator playbook derived from RunForge evidence.\n\n## Source Evidence References\n- [Alpha-15 factory trial](../decisions/alpha-15-factory-trial.md)\n- [Alpha-16 setup preflight](../decisions/alpha-16-setup-preflight.md)\n\n## Related Concepts\n- [Do not apply](../concepts/do-not-apply.md)\n- [Packet validation](../concepts/packet-validation.md)\n\n## Safety Notes\nHuman review is required before applying patches or promoting skills.`;
}

function decisionBody(milestone: string): string {
  return `# ${milestone} Decision\n\n## Summary\nOperator decision captured as portable knowledge for future review.\n\n## Source Evidence\n- [${milestone} milestone](../milestones/${milestone.toLowerCase()}.md)\n\n## Related Concepts\n- [Dependency missing](../concepts/dependency-missing.md)\n- [Environment error](../concepts/environment-error.md)\n\n## Safety Notes\nDo not auto-install dependencies or auto-apply generated patches without explicit operator intent.`;
}

function skillCandidateBody(): string {
  return `# Skill Candidates\n\n## Summary\nCandidate skills are lifecycle inventory items only. They are not active skills and require human/PR review.\n\n## Candidate Areas\n- Setup/preflight diagnosis\n- Provider patch review\n- External operator trial\n- Packet/dashboard operator review\n- OKF knowledge export\n\n## Related Concepts\n- [Setup preflight](../concepts/setup-preflight.md)\n- [Provider rejected](../concepts/provider-rejected.md)\n\n## Curator Report\nRun \`pnpm dev skills curator-report --runs validation/runs --out /tmp/runforge-skill-curator\` to generate the latest candidate report.`;
}

async function collectMarkdown(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectMarkdown(root, child);
    return Promise.resolve(entry.isFile() && entry.name.endsWith(".md") ? [child] : []);
  }));
  return nested.flat();
}

function milestoneTitle(milestone: string): string {
  return milestone === "ALPHA-16" ? "Setup Preflight" : "Validation";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
