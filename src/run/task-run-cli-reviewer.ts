import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ReviewConfidence,
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
  ReviewStatus,
  TaskRunReviewer
} from "./task-run-reviewer.js";

const execFileAsync = promisify(execFile);

export class CliDelegatedEvidenceReviewer implements TaskRunReviewer {
  readonly adapterName = "task-run-cli-reviewer";

  constructor(
    private readonly input: {
      providerInputJsonPath: string;
      providerInputMarkdownPath: string;
      reviewDir: string;
      model?: string;
      providerCommand?: string;
      providerArgs?: string[];
    }
  ) {}

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const providerCommand = this.input.providerCommand?.trim();
    if (!providerCommand) return this.unavailable(request, "RUNFORGE_TASK_RUN_REVIEWER_CLI is not set.");

    try {
      const { stdout } = await execFileAsync(providerCommand, [...(this.input.providerArgs ?? []), this.input.providerInputJsonPath], {
        cwd: this.input.reviewDir,
        env: safeProviderEnv(),
        timeout: 120_000,
        maxBuffer: 1024 * 1024
      });
      return normalizeCliReview(stdout, request);
    } catch (error) {
      return this.unavailable(request, error instanceof Error ? error.message : String(error));
    }
  }

  private unavailable(request: ReviewRequest, reason: string): ReviewResult {
    return {
      reviewer: "cli-delegated-evidence-reviewer",
      provider: "cli",
      status: "provider_unavailable",
      confidence: "low",
      findings: [
        {
          severity: "warning",
          message: `CLI delegated reviewer unavailable: ${reason}`,
          evidenceReferences: [this.input.providerInputJsonPath, this.input.providerInputMarkdownPath]
        }
      ],
      risks: [
        "No real provider judgment was produced; only deterministic evidence remains available.",
        ...request.gaps
      ],
      recommendedNextAction:
        "Treat this as a clean provider-unavailable run. Configure a read-only local reviewer CLI before relying on AI-assisted delegated review.",
      evidenceReferences: [this.input.providerInputJsonPath, this.input.providerInputMarkdownPath, ...request.logPaths.map((item) => item.executorReport)],
      humanDecisionRequired: true
    };
  }
}

function normalizeCliReview(stdout: string, request: ReviewRequest): ReviewResult {
  const parsed = parseCliJson(stdout);
  const findings = normalizeFindings(parsed.findings);
  return {
    reviewer: "cli-delegated-evidence-reviewer",
    provider: "cli",
    status: normalizeStatus(parsed.status),
    confidence: normalizeConfidence(parsed.confidence),
    findings:
      findings.length > 0
        ? findings
        : [
            {
              severity: "info",
              message: boundedText(stdout.trim() || "CLI reviewer returned no textual review.", 1000),
              evidenceReferences: ["review/provider-input.json", "review/provider-input.md"]
            }
          ],
    risks: normalizeStringArray(parsed.risks, request.gaps),
    recommendedNextAction:
      typeof parsed.recommendedNextAction === "string" && parsed.recommendedNextAction.trim()
        ? boundedText(parsed.recommendedNextAction, 1000)
        : "Owner should compare CLI provider review findings against deterministic task-run facts before deciding.",
    evidenceReferences: normalizeStringArray(parsed.evidenceReferences, ["review/provider-input.json", "review/provider-input.md"]),
    humanDecisionRequired: typeof parsed.humanDecisionRequired === "boolean" ? parsed.humanDecisionRequired : true
  };
}

function parseCliJson(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    return {
      severity: normalizeSeverity(record.severity),
      message: boundedText(typeof record.message === "string" ? record.message : "Provider finding omitted a message.", 1000),
      evidenceReferences: normalizeStringArray(record.evidenceReferences, []).slice(0, 10)
    };
  });
}

function normalizeStatus(value: unknown): ReviewStatus {
  return value === "accepted" || value === "needs_attention" || value === "blocked" ? value : "needs_attention";
}

function normalizeConfidence(value: unknown): ReviewConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function normalizeSeverity(value: unknown): ReviewFinding["severity"] {
  return value === "info" || value === "warning" || value === "error" ? value : "warning";
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => boundedText(item, 1000));
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

function safeProviderEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    RUNFORGE_PROVIDER_MODE: "task-run-review",
    RUNFORGE_PROVIDER_READ_ONLY: "true"
  };
}
