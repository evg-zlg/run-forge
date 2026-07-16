import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskRunResult } from "../../src/run/task-run-harness.js";
import { ownerConclusion, remainingGaps } from "../../src/run/task-run-owner-decision.js";
import { planTaskRun } from "../../src/run/task-run-planner.js";
import {
  buildProviderReviewMetadata,
  buildReviewRequest,
  CliDelegatedEvidenceReviewer,
  DeterministicEvidenceReviewer,
  MockDelegatedEvidenceReviewer,
  writeProviderInputPackage
} from "../../src/run/task-run-reviewer.js";
import { renderSummary, toJsonResult, validateSummaryFreshness } from "../../src/run/task-run-renderer.js";

describe("task-run summary renderer", () => {
  it("renders and validates the current task-run command instead of copied stale wording", () => {
    const result = taskRunResult({
      runId: "TASK-RUN-99",
      task: "Inspect the task-run harness and add one narrow guard that prevents stale copied task wording in generated TASK-RUN summaries",
      outDir: "validation/runs/TASK-RUN-99"
    });

    const summary = renderSummary(result);

    expect(summary).toContain("TASK-RUN-99");
    expect(summary).toContain(result.task);
    expect(summary).toContain("Task kind: `code-inspection`");
    expect(summary).toContain("Deterministic Facts");
    expect(summary).toContain("Delegated Review");
    expect(summary).toContain("Provider review metadata: n/a (providerless default)");
    expect(summary).toContain("Owner Decision");
    expect(summary).toContain(`${result.outDir}/review/review-result.json`);
    expect(summary).toContain("Evidence Captured");
    expect(summary).toContain(
      `corepack pnpm dev task-run start --task "${result.task}" --out validation/runs/TASK-RUN-99`
    );
    expect(summary).not.toContain('--task "Check roadmap docs consistency" --out validation/runs/TASK-RUN-2');
    expect(() => validateSummaryFreshness(result, summary)).not.toThrow();
  });

  it("rejects summaries that omit the current task-run command", () => {
    const result = taskRunResult({
      runId: "TASK-RUN-100",
      task: "Current task text",
      outDir: "validation/runs/TASK-RUN-100"
    });

    expect(() => validateSummaryFreshness(result, "# TASK-RUN-100 Summary\n\nCurrent task text\n")).toThrow(
      "current task-run command"
    );
  });

  it("exposes source mutation as a blocking safety failure in summary and results", () => {
    const result = taskRunResult({ runId: "EXTERNAL-SAFETY", task: "Validate external source", outDir: "validation/runs/EXTERNAL-SAFETY" });
    result.status = "failed";
    result.sourceRepository = {
      external: true,
      before: { path: "/repo", head: "before", status: "" },
      after: { path: "/repo", head: "after", status: " M source.ts" },
      unchanged: false
    };
    result.safety = { sourceMutationDetected: true, blockingFailures: ["Blocking safety failure: external source mutation detected."] };

    expect(renderSummary(result)).toContain("Source mutation detected: yes");
    expect(toJsonResult(result)).toMatchObject({
      status: "failed",
      safety: { sourceMutationDetected: true, blockingFailures: ["Blocking safety failure: external source mutation detected."] }
    });
  });

  it("exposes the normalized result contract alongside legacy detail", () => {
    const result = taskRunResult({ runId: "TASK-RESULT-1", task: "Validate safely", outDir: "validation/runs/TASK-RESULT-1" });
    expect(toJsonResult(result, "STABLE-TASK-ID")).toMatchObject({
      schemaVersion: 1,
      contract: "runforge-task-result",
      taskId: "STABLE-TASK-ID",
      status: "completed",
      targetRepository: { changed: false },
      ownerGate: { required: true, status: "awaiting_owner_decision" },
      safetyAssertions: { targetMainPush: false, targetPrMerge: false, deploy: false },
      errors: []
    });
    const json = toJsonResult(result, "STABLE-TASK-ID") as { validation: Array<{ command: string; kind: string }> };
    expect(json.validation.some((item) => item.kind === "task-validation")).toBe(true);
    expect(json.validation.some((item) => item.kind === "safety-check")).toBe(true);
  });
});

describe("task-run review lane", () => {
  it("builds providerless review requests from evidence and returns read-only review results", async () => {
    const result = taskRunResult({
      runId: "TASK-RUN-101",
      task: "Inspect task-run harness code and report the next smallest implementation gap.",
      outDir: "validation/runs/TASK-RUN-101"
    });

    const request = buildReviewRequest({
      runId: result.runId,
      acceptedTask: result.task,
      taskKind: result.taskKind,
      plan: planTaskRun(result.task),
      subtasks: result.subtasks,
      checks: result.checks,
      gaps: result.gaps
    });
    const review = await new DeterministicEvidenceReviewer().review(request);

    expect(request.acceptedTask).toBe(result.task);
    expect(request.logPaths[0]?.commandLog).toContain("command.log");
    expect(review.provider).toBe("providerless");
    expect(review.reviewer).toBe("deterministic-evidence-reviewer");
    expect(review.evidenceReferences.some((item) => item.includes("executor-report.json"))).toBe(true);
    expect(review.recommendedNextAction).not.toMatch(/apply|patch|push|merge|deploy/i);
  });

  it("requires explicit mock mode to produce delegated provider metadata", async () => {
    const result = taskRunResult({
      runId: "TASK-RUN-102",
      task: "Inspect task-run harness code and report delegated review readiness.",
      outDir: "validation/runs/TASK-RUN-102"
    });
    const request = buildReviewRequest({
      runId: result.runId,
      acceptedTask: result.task,
      taskKind: result.taskKind,
      plan: planTaskRun(result.task),
      subtasks: result.subtasks,
      checks: result.checks,
      gaps: result.gaps
    });

    const review = await new MockDelegatedEvidenceReviewer().review(request);
    const metadata = buildProviderReviewMetadata({
      mode: "delegated-mock",
      provider: review.provider,
      reviewer: review.reviewer,
      explicitFlagProvided: true,
      reviewRequestPath: `${result.outDir}/review/review-request.json`,
      reviewResultPath: `${result.outDir}/review/review-result.json`,
      reviewMarkdownPath: `${result.outDir}/review/review.md`,
      evidenceReferences: review.evidenceReferences
    });

    expect(review.provider).toBe("mock");
    expect(review.reviewer).toBe("mock-delegated-evidence-reviewer");
    expect(review.findings.some((item) => item.message.includes("evidence packet only"))).toBe(true);
    expect(metadata.explicitFlagRequired).toBe(true);
    expect(metadata.explicitFlagProvided).toBe(true);
    expect(metadata.readOnly).toBe(true);
    expect(metadata.mutationForbidden).toBe(true);
    expect(metadata.networkAccess).toBe("not_requested");
    expect(metadata.secretsAccess).toBe("not_requested");
    expect(metadata.repoAccess).toBe("evidence_packet_only");
  });

  it("builds bounded provider input packages for delegated reviewer modes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "runforge-provider-input-"));
    const result = taskRunResult({
      runId: "TASK-RUN-103",
      task: "Inspect task-run harness code and report delegated review input bounds.",
      outDir: "validation/runs/TASK-RUN-103"
    });
    const request = buildReviewRequest({
      runId: result.runId,
      acceptedTask: result.task,
      taskKind: result.taskKind,
      plan: planTaskRun(result.task),
      subtasks: result.subtasks,
      checks: result.checks,
      gaps: result.gaps
    });
    for (const log of request.logPaths.flatMap((item) => [item.commandLog, item.stdoutLog, item.stderrLog, item.executorReport])) {
      const path = join(repoRoot, log);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "x".repeat(6000), "utf8");
    }

    const output = await writeProviderInputPackage({
      request,
      repoRoot,
      jsonPath: join(repoRoot, "provider-input.json"),
      markdownPath: join(repoRoot, "provider-input.md")
    });

    expect(output.inputBytes).toBeGreaterThan(0);
    expect(output.inputTruncated).toBe(true);
    expect(output.package.limits.maxTotalLogBytes).toBe(16_000);
    expect(output.package.boundedLogExcerpts.every((item) => item.excerpt.length <= 4000)).toBe(true);
    expect(output.package.evidencePaths.some((item) => item.includes("executor-report.json"))).toBe(true);
  });

  it("requires explicit cli mode and fails cleanly when provider CLI is unavailable", async () => {
    const result = taskRunResult({
      runId: "TASK-RUN-104",
      task: "Inspect task-run harness code and report real provider readiness.",
      outDir: "validation/runs/TASK-RUN-104"
    });
    const request = buildReviewRequest({
      runId: result.runId,
      acceptedTask: result.task,
      taskKind: result.taskKind,
      plan: planTaskRun(result.task),
      subtasks: result.subtasks,
      checks: result.checks,
      gaps: result.gaps
    });

    const review = await new CliDelegatedEvidenceReviewer({
      providerInputJsonPath: "review/provider-input.json",
      providerInputMarkdownPath: "review/provider-input.md",
      reviewDir: "/tmp",
      providerCommand: undefined
    }).review(request);
    const metadata = buildProviderReviewMetadata({
      mode: "delegated-cli",
      provider: review.provider,
      reviewer: review.reviewer,
      explicitFlagProvided: true,
      adapterName: "task-run-cli-reviewer",
      model: null,
      networkUsed: false,
      inputBytes: 123,
      inputTruncated: false,
      reviewRequestPath: `${result.outDir}/review/review-request.json`,
      reviewResultPath: `${result.outDir}/review/review-result.json`,
      reviewMarkdownPath: `${result.outDir}/review/review.md`,
      providerInputJsonPath: `${result.outDir}/review/provider-input.json`,
      providerInputMarkdownPath: `${result.outDir}/review/provider-input.md`,
      evidenceReferences: review.evidenceReferences
    });

    expect(review.provider).toBe("cli");
    expect(review.status).toBe("provider_unavailable");
    expect(review.recommendedNextAction).toContain("provider-unavailable");
    expect(metadata.providerMode).toBe("delegated-cli");
    expect(metadata.adapterName).toBe("task-run-cli-reviewer");
    expect(metadata.networkUsed).toBe(false);
    expect(metadata.secretsRequested).toBe(false);
    expect(metadata.inputBytes).toBe(123);
    expect(metadata.repoAccess).toBe("evidence_packet_only");
  });
});

describe("task-run planner", () => {
  it("creates meaningfully different plans for docs and code tasks", () => {
    const docs = planTaskRun("Review Agent OS roadmap docs and report contradictions, gaps, and next milestone.");
    const code = planTaskRun("Inspect task-run harness code and report the next smallest implementation gap.");

    expect(docs.kind).toBe("docs-review");
    expect(code.kind).toBe("code-inspection");
    expect(docs.subtasks.map((item) => item.id)).not.toEqual(code.subtasks.map((item) => item.id));
    expect(docs.inputs).toContain("docs/ROADMAP.md");
    expect(code.inputs).toContain("src/run/task-run-harness.ts");
    expect(docs.subtasks.some((item) => item.evidenceCommand.includes("docs/ROADMAP.md"))).toBe(true);
    expect(code.subtasks.some((item) => item.evidenceCommand.includes("src/run/task-run-harness.ts"))).toBe(true);
  });

  it("binds non-provider planning tasks to semantic owner-decision milestone", () => {
    const plan = planTaskRun("Inspect task-run harness and identify the next non-provider implementation gap after executor dispatch");

    expect(plan.kind).toBe("code-inspection");
    expect(plan.recommendedNextMilestone).toBe("semantic task-specific planning / owner-decision binding");
    expect(plan.subtasks.map((item) => item.id)).toEqual([
      "01-planner-task-binding",
      "02-owner-decision-binding",
      "03-artifact-consistency-check"
    ]);
    expect(plan.subtasks.some((item) => item.goal.includes(plan.recommendedNextMilestone))).toBe(true);
  });

  it("routes Docker runtime work to code evidence instead of matching doc inside docker", () => {
    const plan = planTaskRun("Add an opt-in Docker-isolated task execution lane with owner-visible runtime metadata");

    expect(plan.kind).toBe("code-inspection");
    expect(plan.recommendedNextMilestone).toBe("external-repo check/triage through Docker runtime");
    expect(plan.subtasks.map((item) => item.id)).toEqual([
      "01-runtime-cli-and-dispatch",
      "02-container-safety-policy",
      "03-runtime-evidence-contract"
    ]);
  });
});

describe("task-run owner decision binding", () => {
  it("does not drift to provider recommendations for non-provider code tasks", () => {
    const task = "Inspect task-run harness and identify the next non-provider implementation gap after executor dispatch";
    const conclusion = ownerConclusion(task, "code-inspection");
    const gaps = remainingGaps("code-inspection", task);

    expect(conclusion).toContain("semantic task-specific planning / owner-decision binding");
    expect(conclusion).toContain("non-provider code task");
    expect(conclusion).not.toMatch(/delegated coding\/review agents/);
    expect(gaps).toContain("Planner lanes, selected milestone, and owner conclusions still need stronger binding to the accepted task.");
    expect(gaps.join(" ")).not.toMatch(/delegated coding\/review agents/);
  });

  it("keeps docs tasks about docs evidence", () => {
    const conclusion = ownerConclusion("Review roadmap docs for contradictions", "docs-review");

    expect(conclusion).toContain("docs task");
    expect(conclusion).toContain("documentation consistency");
    expect(conclusion).not.toMatch(/provider|delegated/i);
  });
});

function taskRunResult(input: { runId: string; task: string; outDir: string }): TaskRunResult {
  return {
    runId: input.runId,
    task: input.task,
    taskKind: "code-inspection",
    planningBasis: ["Task asks for harness code inspection."],
    selectedMilestone: "real executor dispatch",
    ownerConclusion: "The accepted code task was answered from harness evidence.",
    recommendedNextStep: "Recommended next milestone: real executor dispatch.",
    gaps: ["Docker/container isolation is still recorded as a gap."],
    status: "completed",
    outDir: input.outDir,
    tmpRoot: `/tmp/runforge-${input.runId.toLowerCase()}`,
    runtime: {
      mode: "local",
      executor: "local-shell",
      image: null
    },
    sourceRepository: {
      external: false,
      before: null,
      after: null,
      unchanged: null
    },
    preparationMode: "none",
    preparation: null,
    safety: {
      sourceMutationDetected: false,
      blockingFailures: []
    },
    plan: `${input.outDir}/plan.md`,
    summary: `${input.outDir}/summary.md`,
    results: `${input.outDir}/results.json`,
    review: {
      request: `${input.outDir}/review/review-request.json`,
      result: `${input.outDir}/review/review-result.json`,
      markdown: `${input.outDir}/review/review.md`,
      requestPayload: {
        runId: input.runId,
        acceptedTask: input.task,
        taskKind: "code-inspection",
        plan: planTaskRun(input.task),
        subtaskReports: [
          {
            id: "04-check-and-owner-summary",
            goal: "Run the configured check command and aggregate owner-ready summary/results artifacts.",
            reportPath: `${input.outDir}/subtasks/04-check-and-owner-summary/report.md`,
            findings: ["The summary renderer was inspected for stale copied task wording."],
            status: "done"
          }
        ],
        executorResults: [
          {
            subtaskId: "04-check-and-owner-summary",
            requestId: `${input.runId}:04-check-and-owner-summary:local-shell`,
            executor: "local-shell",
            status: "passed",
            exitCode: 0,
            timedOut: false
          }
        ],
        commandStatuses: [
          {
            subtaskId: "04-check-and-owner-summary",
            command: "rg -n task-run src/run/task-run-renderer.ts",
            status: "passed",
            exitCode: 0
          }
        ],
        logPaths: [
          {
            subtaskId: "04-check-and-owner-summary",
            commandLog: `${input.outDir}/subtasks/04-check-and-owner-summary/command.log`,
            stdoutLog: `${input.outDir}/subtasks/04-check-and-owner-summary/stdout.log`,
            stderrLog: `${input.outDir}/subtasks/04-check-and-owner-summary/stderr.log`,
            executorReport: `${input.outDir}/subtasks/04-check-and-owner-summary/executor-report.json`
          }
        ],
        checks: [{ command: "corepack pnpm check:structure", result: "passed", exitCode: 0 }],
        gaps: ["Docker/container isolation is still recorded as a gap."]
      },
      resultPayload: {
        reviewer: "deterministic-evidence-reviewer",
        provider: "providerless",
        status: "accepted",
        confidence: "medium",
        findings: [
          {
            severity: "info",
            message: "Reviewed 1 subtask report(s), 1 command status record(s), and 1 owner check(s).",
            evidenceReferences: [`${input.outDir}/subtasks/04-check-and-owner-summary/report.md`]
          }
        ],
        risks: ["Docker/container isolation is still recorded as a gap."],
        recommendedNextAction: "Owner can use the summary and review artifacts as evidence for the next milestone decision.",
        evidenceReferences: [
          `${input.outDir}/subtasks/04-check-and-owner-summary/report.md`,
          `${input.outDir}/subtasks/04-check-and-owner-summary/command.log`,
          `${input.outDir}/subtasks/04-check-and-owner-summary/stdout.log`,
          `${input.outDir}/subtasks/04-check-and-owner-summary/stderr.log`,
          `${input.outDir}/subtasks/04-check-and-owner-summary/executor-report.json`
        ],
        humanDecisionRequired: true
      }
    },
    subtasks: [
      {
        id: "04-check-and-owner-summary",
        goal: "Run the configured check command and aggregate owner-ready summary/results artifacts.",
        inputs: ["src/run/task-run-renderer.ts"],
        findings: ["The summary renderer was inspected for stale copied task wording."],
        status: "done",
        artifacts: ["brief.md", "report.md", "command.log"],
        evidence: {
          command: "rg -n task-run src/run/task-run-renderer.ts",
          status: "passed",
          exitCode: 0,
          logPath: `${input.outDir}/subtasks/04-check-and-owner-summary/command.log`,
          inspected: ["src/run/task-run-renderer.ts"],
          summary: "04-check-and-owner-summary captured command evidence.",
          executorReport: `${input.outDir}/subtasks/04-check-and-owner-summary/executor-report.json`
        },
        executor: {
          requestId: `${input.runId}:04-check-and-owner-summary:local-shell`,
          subtaskId: "04-check-and-owner-summary",
          executor: "local-shell",
          runtime: {
            isolation: "host-process",
            image: null,
            network: "host"
          },
          status: "passed",
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "src/run/task-run-renderer.ts:1:task-run\n",
          stderr: "",
          artifactPaths: {
            commandLog: `${input.outDir}/subtasks/04-check-and-owner-summary/command.log`,
            stdoutLog: `${input.outDir}/subtasks/04-check-and-owner-summary/stdout.log`,
            stderrLog: `${input.outDir}/subtasks/04-check-and-owner-summary/stderr.log`,
            report: `${input.outDir}/subtasks/04-check-and-owner-summary/executor-report.json`
          }
        },
        workspace: `/tmp/runforge-${input.runId.toLowerCase()}/04-check-and-owner-summary/workspace`,
        report: `${input.outDir}/subtasks/04-check-and-owner-summary/report.md`
      }
    ],
    checks: [
      {
        command: "corepack pnpm check:structure",
        result: "passed",
        exitCode: 0,
        stdout: "",
        stderr: ""
      }
    ]
  };
}
