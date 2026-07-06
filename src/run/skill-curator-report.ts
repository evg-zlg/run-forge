import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SkillCandidate {
  name: string;
  trigger: string;
  evidence: string[];
  safetyBoundaries: string[];
  recommendedAction: string;
}

export interface SkillCuratorResult {
  generatedAt: string;
  runs: string;
  candidates: SkillCandidate[];
  markdownPath: string;
  jsonPath: string;
}

export async function buildSkillCuratorReport(options: { runs: string; out: string }): Promise<SkillCuratorResult> {
  const runs = resolve(options.runs);
  const out = resolve(options.out);
  const candidates = candidateCatalog(runs);
  const result = {
    generatedAt: new Date().toISOString(),
    runs,
    candidates,
    markdownPath: join(out, "curator-report.md"),
    jsonPath: join(out, "skill-candidates.json")
  };
  await mkdir(out, { recursive: true });
  await writeFile(result.jsonPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8");
  await writeFile(result.markdownPath, renderSkillCuratorReport(result), "utf8");
  return result;
}

export function renderSkillCuratorReport(result: SkillCuratorResult): string {
  return [
    "# RunForge Skill Curator Report",
    "",
    `Generated at: ${result.generatedAt}`,
    `Evidence root: ${result.runs}`,
    "",
    "## Summary",
    "",
    "Candidate skills below are proposed lifecycle inventory items only. They are not active skills and require human/PR review.",
    "",
    "## Candidates",
    "",
    ...result.candidates.flatMap((candidate) => [
      `### ${candidate.name}`,
      "",
      `Trigger: ${candidate.trigger}`,
      "",
      "Evidence:",
      ...candidate.evidence.map((item) => `- ${item}`),
      "",
      "Safety boundaries:",
      ...candidate.safetyBoundaries.map((item) => `- ${item}`),
      "",
      `Recommended action: ${candidate.recommendedAction}`,
      ""
    ])
  ].join("\n");
}

function candidateCatalog(runs: string): SkillCandidate[] {
  const evidence = (path: string) => join(runs, path);
  return [
    {
      name: "external-operator-trial",
      trigger: "operator runs RunForge against an external repo and needs packet/dashboard evidence",
      evidence: [evidence("ALPHA-15/summary.md"), evidence("ALPHA-15/operator-decisions.md")],
      safetyBoundaries: ["do not mutate original repo", "record before/after HEAD", "human apply decision required"],
      recommendedAction: "propose skill via PR"
    },
    {
      name: "provider-patch-review",
      trigger: "provider emits patch or proposal that needs safety review",
      evidence: [evidence("ALPHA-9/summary.md"), evidence("ALPHA-15/summary.md")],
      safetyBoundaries: ["reject forbidden paths", "do not auto-apply provider output", "preserve audit artifacts"],
      recommendedAction: "propose skill via PR"
    },
    {
      name: "setup-preflight-diagnosis",
      trigger: "dependency/setup failure in disposable workspace",
      evidence: [evidence("ALPHA-15/summary.md"), evidence("ALPHA-16/summary.md")],
      safetyBoundaries: ["do not mutate original repo", "do not auto-install unless explicit", "keep setup failures out of code proposal readiness"],
      recommendedAction: "propose skill via PR"
    },
    {
      name: "environment-aware-readiness",
      trigger: "triage sees missing dependencies, environment errors, or setup timeouts",
      evidence: [evidence("ALPHA-15/summary.md"), evidence("ALPHA-16/results.json")],
      safetyBoundaries: ["request more context before proposing code", "surface setup/preflight logs", "avoid false source-code blame"],
      recommendedAction: "propose skill via PR"
    },
    {
      name: "packet-dashboard-operator-review",
      trigger: "operator needs to inspect packets, indexes, dashboard seed, or viewers",
      evidence: [evidence("ALPHA-14/summary.md"), evidence("ALPHA-15/summary.md")],
      safetyBoundaries: ["read-only review by default", "link to packet evidence", "do not replace packet formats"],
      recommendedAction: "propose skill via PR"
    },
    {
      name: "okf-knowledge-export",
      trigger: "operator wants portable reviewable knowledge from RunForge evidence",
      evidence: [evidence("ALPHA-16/summary.md")],
      safetyBoundaries: ["export only", "do not include raw logs or secrets", "do not make OKF a runtime requirement"],
      recommendedAction: "keep candidate under review after Alpha-17 validation"
    }
  ];
}
