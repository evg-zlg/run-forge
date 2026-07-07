import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findSecretLikeContent } from "./okf-secret-scan.js";
import type { LifecycleStatus } from "./lifecycle-status.js";

export interface SkillCandidate {
  name: string;
  trigger: string;
  evidence: string[];
  safetyBoundaries: string[];
  lifecycleStatus: LifecycleStatus;
  findings: string[];
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
  const candidates = await candidateCatalog(runs);
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
      `Lifecycle status: ${candidate.lifecycleStatus}`,
      "",
      "Findings:",
      ...(candidate.findings.length > 0 ? candidate.findings.map((item) => `- ${item}`) : ["- ready for operator review"]),
      "",
      `Recommended action: ${candidate.recommendedAction}`,
      ""
    ])
  ].join("\n");
}

async function candidateCatalog(runs: string): Promise<SkillCandidate[]> {
  const evidence = (path: string) => join(runs, path);
  const candidates = [
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
  const names = candidates.map((candidate) => candidate.name);
  return Promise.all(candidates.map(async (candidate) => enrichCandidate(candidate, names)));
}

async function enrichCandidate(candidate: Omit<SkillCandidate, "lifecycleStatus" | "findings">, names: string[]): Promise<SkillCandidate> {
  const findings: string[] = [];
  const missing = await missingEvidence(candidate.evidence);
  if (missing.length > 0) findings.push(`missing evidence links: ${missing.join(", ")}`);
  if (candidate.evidence.length === 0) findings.push("skill has no evidence links");
  if (/\bALPHA-(?:[1-9]|1[0-6])\b/.test(candidate.evidence.join(" ")) && !/ALPHA-(?:17|18|19)/.test(candidate.evidence.join(" "))) findings.push("mentions older Alpha milestones without newer support");
  if (overlaps(candidate.name, names).length > 0) findings.push(`possible duplicate or overlap: ${overlaps(candidate.name, names).join(", ")}`);
  if (findSecretLikeContent([candidate.name, candidate.trigger, ...candidate.evidence, ...candidate.safetyBoundaries].join("\n")).length > 0) findings.push("forbidden or secret-like content");
  if (candidate.trigger.split(/\s+/).length < 6 || candidate.safetyBoundaries.length < 2) findings.push("too vague to act on safely");
  const lifecycleStatus = statusFor(findings);
  return {
    ...candidate,
    lifecycleStatus,
    findings,
    recommendedAction: lifecycleStatus === "active" ? "promote to active after operator PR review" : lifecycleStatus === "unsafe" ? "retire or rewrite before use" : "review before promotion"
  };
}

async function missingEvidence(evidence: string[]): Promise<string[]> {
  const checks = await Promise.all(evidence.map(async (file) => access(file).then(() => undefined).catch(() => file)));
  return checks.filter((file): file is string => Boolean(file));
}

function overlaps(name: string, names: string[]): string[] {
  const tokens = new Set(name.split("-").filter((token) => token.length > 4));
  return names.filter((other) => other !== name && other.split("-").some((token) => tokens.has(token)));
}

function statusFor(findings: string[]): LifecycleStatus {
  if (findings.some((finding) => finding.includes("secret-like") || finding.includes("forbidden"))) return "unsafe";
  if (findings.some((finding) => finding.includes("missing evidence"))) return "missing_evidence";
  if (findings.some((finding) => finding.includes("duplicate") || finding.includes("overlap"))) return "duplicate";
  if (findings.some((finding) => finding.includes("older Alpha"))) return "stale";
  if (findings.some((finding) => finding.includes("vague"))) return "needs_review";
  return "active";
}
