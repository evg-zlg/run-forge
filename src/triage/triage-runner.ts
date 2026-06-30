import { join, resolve } from "node:path";
import { ensureDir, readText, writeJson, writeText } from "../core/artifact-store.js";
import { renderReview } from "../core/report-writer.js";
import { buildSafetyReport } from "../core/safety.js";
import type { TriageOptions } from "../core/types.js";
import { buildTrajectory, createRunId, type TrajectoryStep } from "../core/trajectory.js";
import { MockProvider } from "../providers/mock-provider.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { scanSecrets } from "../security/secret-scan.js";
import { classifyFailure } from "./failure-classifier.js";
import { inspectRepo } from "./repo-inspector.js";
import { buildReview } from "./review-model.js";

export async function runTriage(options: TriageOptions): Promise<void> {
  const repoPath = resolve(options.repoPath);
  const logPath = resolve(options.logPath);
  const outPath = resolve(options.outPath);
  const steps: TrajectoryStep[] = [];
  const runId = createRunId();
  await ensureDir(outPath);

  const logText = await readText(logPath);
  steps.push({ name: "read_log", status: "passed", summary: `Read ${logText.split(/\r?\n/).length} lines` });

  const logSecretScan = scanSecrets(logText);
  const safety = buildSafetyReport(repoPath, logSecretScan);
  await writeJson(join(outPath, "safety-report.json"), safety);
  if (logSecretScan.status === "failed") {
    await writeText(join(outPath, "review.md"), "# Failure Triage Report\n\nBlocked: secret-like values were detected in the input log.\n");
    throw new Error("Secret-like values detected in input log; review generation blocked.");
  }

  const classification = classifyFailure(logText);
  steps.push({ name: "classify_failure", status: "passed", summary: `Classified as ${classification.category}` });

  const repo = await inspectRepo(repoPath, logText);
  steps.push({ name: "inspect_repo", status: "passed", summary: `Found ${Object.keys(repo.scripts).length} package scripts` });

  const provider = options.provider === "openai-compatible" ? new OpenAICompatibleProvider(options.model) : new MockProvider();
  const providerResult = await provider.summarize({ review: buildReview({ logText, classification, repo }) });
  const reviewText = renderReview(providerResult.review);
  const artifactScan = scanSecrets(reviewText);
  if (artifactScan.status === "failed") throw new Error("Secret-like values detected in generated review; write blocked.");

  await writeText(join(outPath, "review.md"), reviewText);
  steps.push({ name: "write_review", status: "passed", summary: "Wrote review.md" });

  await writeJson(join(outPath, "context-summary.json"), { runId, repo, classification, provider: provider.name });
  await writeJson(join(outPath, "trajectory.json"), buildTrajectory({
    runId,
    repoPath: options.repoPath,
    logPath: options.logPath,
    steps,
    safety,
    category: classification.category,
    confidence: classification.confidence,
    humanDecisionNeeded: providerResult.review.humanDecisionNeeded
  }));
}
