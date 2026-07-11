export type TaskKind = "docs-review" | "code-inspection" | "general-review";

export type PlannedSubtask = {
  id: string;
  goal: string;
  inputs: string[];
  evidenceCommand: string;
  evidenceFocus: string;
};

export type TaskRunPlan = {
  kind: TaskKind;
  planningBasis: string[];
  inputs: string[];
  subtasks: PlannedSubtask[];
  recommendedNextMilestone: string;
};

const docsInputs = ["docs/ROADMAP.md", "docs/CURRENT_STATE.md", "docs/DECISIONS.md", "docs/NON_GOALS.md", "docs/USE_CASES.md"];
const codeInputs = [
  "src/cli/commands/task-run.ts",
  "src/run/task-run-harness.ts",
  "src/run/task-run-renderer.ts",
  "tests/unit/task-run-renderer.test.ts",
  "package.json",
  "validation/runs/TASK-RUN-4"
];

export function planTaskRun(task: string): TaskRunPlan {
  const kind = classifyTask(task);
  if (kind === "docs-review") return docsPlan(task);
  if (kind === "code-inspection") return codePlan(task);
  return generalPlan(task);
}

function classifyTask(task: string): TaskKind {
  const normalized = task.toLowerCase();
  const docsScore = score(normalized, ["doc", "roadmap", "contradiction", "milestone", "non-goal", "current state"]);
  const codeScore = score(normalized, ["code", "harness", "implementation", "typescript", "test", "cli", "renderer"]);
  if (docsScore > codeScore && docsScore > 0) return "docs-review";
  if (codeScore > 0) return "code-inspection";
  return "general-review";
}

function docsPlan(task: string): TaskRunPlan {
  return {
    kind: "docs-review",
    planningBasis: ["Task asks for roadmap documentation review.", "Use roadmap/current/non-goal/decision docs as primary evidence."],
    inputs: docsInputs,
    recommendedNextMilestone: selectedMilestone(task, "docs"),
    subtasks: [
      {
        id: "01-roadmap-source-map",
        goal: "Map the Agent OS roadmap claims, current state, and frozen scope.",
        inputs: docsInputs.slice(0, 4),
        evidenceFocus: "Roadmap/current-state claims and frozen constraints.",
        evidenceCommand:
          "rg -n \"Agent OS|Task Factory|TASK-RUN|Next Milestone|Frozen|Alpha-28|Docker|isolated|owner\" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md"
      },
      {
        id: "02-contradiction-and-gap-scan",
        goal: "Scan roadmap docs for contradictions, missing loop stages, and scope drift risks.",
        inputs: docsInputs,
        evidenceFocus: "Contradictions, missing task-run stages, and platform drift signals.",
        evidenceCommand:
          "rg -n \"missing|gap|not yet|future|frozen|out of scope|not the product|drift|container|VPS|executor|aggregation|owner\" docs/ROADMAP.md docs/CURRENT_STATE.md docs/DECISIONS.md docs/NON_GOALS.md docs/USE_CASES.md"
      },
      {
        id: "03-next-milestone-readiness",
        goal: "Identify the next milestone that best closes the documented roadmap gap.",
        inputs: ["docs/ROADMAP.md", "docs/CURRENT_STATE.md", "validation/runs/TASK-RUN-4/summary.md"],
        evidenceFocus: "Next milestone evidence and TASK-RUN harness gaps.",
        evidenceCommand:
          "rg -n \"Next Milestone|TASK-RUN|Remaining Gaps|Recommended Next Milestone|semantic planning|executor dispatch|aggregation|Docker\" docs/ROADMAP.md docs/CURRENT_STATE.md validation/runs/TASK-RUN-4/summary.md"
      }
    ]
  };
}

function codePlan(task: string): TaskRunPlan {
  if (asksForSemanticPlanning(task)) return semanticPlanningCodePlan();
  return {
    kind: "code-inspection",
    planningBasis: ["Task asks for harness code inspection.", "Use CLI, harness, renderer, tests, and prior run artifacts as primary evidence."],
    inputs: codeInputs,
    recommendedNextMilestone: "executor hardening and delegated review lane",
    subtasks: [
      {
        id: "01-cli-and-entrypoint-map",
        goal: "Map how the task-run command accepts a task and writes run artifacts.",
        inputs: ["src/cli/commands/task-run.ts", "package.json"],
        evidenceFocus: "CLI options, default check command, and demo command wiring.",
        evidenceCommand: "sed -n '1,220p' src/cli/commands/task-run.ts && rg -n \"task-run\" package.json"
      },
      {
        id: "02-planner-executor-gap",
        goal: "Inspect planner, isolation, evidence, and aggregation behavior in harness code.",
        inputs: ["src/run/task-run-harness.ts", "src/run/task-run-renderer.ts"],
        evidenceFocus: "Static versus task-derived planning and whether commands/logs are captured per subtask.",
        evidenceCommand:
          "rg -n \"subtasks|renderPlan|renderReport|runCheck|copyWorkspace|evidence|aggregation|recommended\" src/run/task-run-harness.ts src/run/task-run-renderer.ts"
      },
      {
        id: "03-test-and-artifact-gap",
        goal: "Check whether tests and prior artifacts prove task-specific plans and evidence.",
        inputs: ["tests/unit/task-run-renderer.test.ts", "validation/runs/TASK-RUN-4/results.json"],
        evidenceFocus: "Coverage of planning/aggregation and previous artifact limitations.",
        evidenceCommand:
          "sed -n '1,220p' tests/unit/task-run-renderer.test.ts && rg -n \"taskKind|planningBasis|evidence|Remaining Gaps|subtasks\" validation/runs/TASK-RUN-4/results.json"
      }
    ]
  };
}

function semanticPlanningCodePlan(): TaskRunPlan {
  const milestone = "semantic task-specific planning / owner-decision binding";
  return {
    kind: "code-inspection",
    planningBasis: [
      "Task asks for a non-provider harness implementation gap after executor dispatch.",
      "Recent governor evidence identified owner-conclusion drift toward provider work for non-provider tasks.",
      "Use planner, owner-decision, renderer, tests, and GOVERNOR-1 artifacts as primary evidence."
    ],
    inputs: [
      "src/run/task-run-planner.ts",
      "src/run/task-run-owner-decision.ts",
      "src/run/task-run-renderer.ts",
      "tests/unit/task-run-renderer.test.ts",
      "validation/runs/GOVERNOR-1/results.json",
      "validation/runs/GOVERNOR-1/summary.md"
    ],
    recommendedNextMilestone: milestone,
    subtasks: [
      {
        id: "01-planner-task-binding",
        goal: `Verify planner classification and recommended milestone bind to ${milestone}.`,
        inputs: ["src/run/task-run-planner.ts", "validation/runs/GOVERNOR-1/results.json"],
        evidenceFocus: "Planner task binding, selected milestone propagation, and non-provider intent.",
        evidenceCommand:
          "rg -n \"semantic task-specific planning|owner-decision|non-provider|recommendedNextMilestone|codePlan|planTaskRun\" src/run/task-run-planner.ts validation/runs/GOVERNOR-1/results.json"
      },
      {
        id: "02-owner-decision-binding",
        goal: `Verify owner decision text recommends ${milestone} without provider drift.`,
        inputs: ["src/run/task-run-owner-decision.ts", "tests/unit/task-run-renderer.test.ts"],
        evidenceFocus: "Owner conclusion and remaining-gap logic for non-provider code tasks.",
        evidenceCommand:
          "rg -n \"semantic task-specific planning|owner-decision binding|non-provider|provider|delegated\" src/run/task-run-owner-decision.ts tests/unit/task-run-renderer.test.ts"
      },
      {
        id: "03-artifact-consistency-check",
        goal: `Confirm plan, summary, review, and results artifacts expose ${milestone}.`,
        inputs: ["src/run/task-run-renderer.ts", "src/run/task-run-reviewer.ts"],
        evidenceFocus: "Selected milestone rendering across owner-visible artifacts.",
        evidenceCommand:
          "rg -n \"selectedMilestone|recommendedNextMilestone|Recommended Next Milestone|Selected Milestone|review\" src/run/task-run-renderer.ts src/run/task-run-reviewer.ts"
      }
    ]
  };
}

function generalPlan(task: string): TaskRunPlan {
  return {
    kind: "general-review",
    planningBasis: [`Task did not match docs or code heuristics exactly: ${task}`, "Use repository overview plus current roadmap docs."],
    inputs: ["README.md", ...docsInputs],
    recommendedNextMilestone: "semantic planner",
    subtasks: [
      {
        id: "01-task-context-map",
        goal: "Map the requested task against available repository context.",
        inputs: ["README.md", "docs/ROADMAP.md", "docs/CURRENT_STATE.md"],
        evidenceFocus: "Relevant repository context for the accepted task.",
        evidenceCommand: "rg -n \"RunForge|Agent OS|task|harness|roadmap|current\" README.md docs/ROADMAP.md docs/CURRENT_STATE.md"
      },
      {
        id: "02-gap-and-next-action",
        goal: "Identify the smallest useful next action for the accepted task.",
        inputs: ["docs/ROADMAP.md", "docs/NON_GOALS.md"],
        evidenceFocus: "Gaps, constraints, and next action candidates.",
        evidenceCommand: "rg -n \"Next Milestone|Missing|Frozen|Out Of Scope|gap|decision\" docs/ROADMAP.md docs/NON_GOALS.md"
      }
    ]
  };
}

function selectedMilestone(task: string, fallback: "docs" | "general"): string {
  if (asksForSemanticPlanning(task)) return "semantic task-specific planning / owner-decision binding";
  return fallback === "docs" ? "semantic planner" : "semantic planner";
}

function asksForSemanticPlanning(task: string): boolean {
  const normalized = task.toLowerCase();
  return (
    normalized.includes("non-provider") ||
    normalized.includes("semantic") ||
    normalized.includes("owner-decision") ||
    normalized.includes("owner decision") ||
    normalized.includes("task-specific planning") ||
    normalized.includes("task-specific planner")
  );
}

function score(value: string, terms: string[]): number {
  return terms.reduce((total, term) => total + (value.includes(term) ? 1 : 0), 0);
}
