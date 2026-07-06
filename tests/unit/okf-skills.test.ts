import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
