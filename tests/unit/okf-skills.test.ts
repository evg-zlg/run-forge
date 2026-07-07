import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildKnowledgeLifecycleReport } from "../../src/run/knowledge-lifecycle.js";
import { exportOkfBundle, validateOkfBundle } from "../../src/run/okf-knowledge-export.js";
import { buildSkillCuratorReport } from "../../src/run/skill-curator-report.js";
import { buildSkillInventory } from "../../src/run/skill-inventory.js";

describe("OKF knowledge export", () => {
  it("creates root index/log with frontmatter types and milestone pages", async () => {
    const root = await fixtureRuns();
    const out = join(root, "okf");

    const result = await exportOkfBundle({ root, out });
    const validation = await validateOkfBundle(out);

    expect(result.files).toContain("index.md");
    expect(result.files).toContain("log.md");
    expect(result.files).toContain("milestones/alpha-16.md");
    expect(await readFile(join(out, "index.md"), "utf8")).toContain("type: RunForge Concept");
    expect(await readFile(join(out, "milestones/alpha-16.md"), "utf8")).toContain("type: RunForge Milestone");
    expect(validation.ok).toBe(true);
  });

  it("exports setup/preflight and provider-rejected concepts", async () => {
    const root = await fixtureRuns();
    const out = join(root, "okf");

    await exportOkfBundle({ root, out });

    expect(await readFile(join(out, "concepts/setup-preflight.md"), "utf8")).toContain("Setup Preflight");
    expect(await readFile(join(out, "concepts/provider-rejected.md"), "utf8")).toContain("Provider Rejected");
    expect(await readFile(join(out, "skill-candidates/index.md"), "utf8")).toContain("Candidate skills");
  });

  it("validation fails on missing frontmatter and secret-like content", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-okf-invalid-"));
    await mkdir(join(root, "concepts"), { recursive: true });
    await mkdir(join(root, "playbooks"), { recursive: true });
    await mkdir(join(root, "milestones"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Missing frontmatter\n", "utf8");
    await writeFile(join(root, "log.md"), "---\ntype: RunForge Concept\n---\n\npassword=supersecretvalue\n", "utf8");

    const result = await validateOkfBundle(root);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("index.md missing frontmatter type");
    expect(result.errors.join("\n")).toContain("secret-like");
    expect(result.errors.join("\n")).toContain("missing evidence/source links");
  });

  it("validation fails on invalid lifecycle status and duplicate IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-okf-lifecycle-invalid-"));
    for (const dir of ["concepts", "playbooks", "milestones"]) await mkdir(join(root, dir), { recursive: true });
    const page = "---\ntype: RunForge Concept\nid: duplicated\nlifecycle: mystery\n---\n\n# Page\n\n## Source Evidence\n- `validation/runs/ALPHA-19/summary.md`\n";
    await writeFile(join(root, "index.md"), page, "utf8");
    await writeFile(join(root, "log.md"), page.replace("mystery", "active"), "utf8");
    await writeFile(join(root, "concepts", "x.md"), page.replace("duplicated", "unique").replace("mystery", "active"), "utf8");

    const result = await validateOkfBundle(root);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid lifecycle status mystery");
    expect(result.errors.join("\n")).toContain("duplicate id/slug duplicated");
  });
});

describe("skill lifecycle reports", () => {
  it("inventory handles missing paths and writes an honest shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-skills-missing-"));
    const out = join(root, "out");

    const result = await buildSkillInventory({ out, roots: [join(root, "missing")] });

    expect(result.skills).toHaveLength(0);
    expect(result.missingRoots).toHaveLength(1);
    expect(await readFile(join(out, "skills-inventory.md"), "utf8")).toContain("Skills found: 0");
  });

  it("curator report emits setup/preflight and provider review candidates", async () => {
    const root = await fixtureRuns();
    const out = join(root, "curator");

    const result = await buildSkillCuratorReport({ runs: root, out });
    const names = result.candidates.map((candidate) => candidate.name);

    expect(names).toContain("setup-preflight-diagnosis");
    expect(names).toContain("provider-patch-review");
    expect(await readFile(join(out, "curator-report.md"), "utf8")).toContain("human/PR review");
    expect(await readFile(join(out, "skill-candidates.json"), "utf8")).toContain("setup-preflight-diagnosis");
    expect(await readFile(join(out, "curator-report.md"), "utf8")).toContain("Lifecycle status:");
  });

  it("builds an operator lifecycle report across OKF, skills, and evidence", async () => {
    const root = await fixtureRuns();
    const repoRoot = await mkdtemp(join(tmpdir(), "runforge-lifecycle-repo-"));
    const out = join(repoRoot, "validation", "runs", "ALPHA-20");
    const skillRoot = join(repoRoot, "skills");
    await mkdir(join(skillRoot, "packet-review"), { recursive: true });
    await writeFile(join(skillRoot, "packet-review", "SKILL.md"), "# Packet Review\n\ndescription: Review packet evidence.\n\nEvidence: validation/runs/ALPHA-19/summary.md\n", "utf8");

    const result = await buildKnowledgeLifecycleReport({ repoRoot, runs: root, out, skillRoots: [skillRoot] });

    expect(result.validation.ok).toBe(true);
    expect(result.sourceCounts.okfFiles).toBeGreaterThan(0);
    expect(result.sourceCounts.skills).toBe(1);
    expect(result.lifecycleStatusCounts.active).toBeGreaterThan(0);
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain("Lifecycle Status Counts");
  });
});

async function fixtureRuns(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runforge-okf-runs-"));
  for (const alpha of ["ALPHA-9", "ALPHA-15", "ALPHA-16", "PACKET-VALIDATION"]) {
    const dir = join(root, alpha);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "summary.md"), `# ${alpha}\n\nSummary evidence.\n`, "utf8");
    await writeFile(join(dir, "results.json"), JSON.stringify({ verdict: "passed" }), "utf8");
  }
  await writeFile(join(root, "ALPHA-15", "operator-decisions.md"), "# Decisions\n\nDo not apply.\n", "utf8");
  return root;
}
