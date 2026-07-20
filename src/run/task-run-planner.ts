import type { CampaignPlan, CampaignPlanNode, CampaignSpec, ControlAuthority } from "../control-plane/contracts.js";
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

export function planExternalValidationTaskRun(task: string, lockfile: string, commands: string[] = []): TaskRunPlan {
  const runner = lockfile === "pnpm-lock.yaml" ? "corepack pnpm" : lockfile === "yarn.lock" ? "corepack yarn" : "npm";
  const selectedCommands = commands.length > 0 ? commands : [`${runner} run typecheck`, `${runner} test`, `${runner} run build`];
  return {
    kind: "code-inspection",
    planningBasis: [
      "Task targets an explicitly declared external JavaScript/TypeScript repository.",
      "Validation commands run sequentially in a prepared disposable Linux workspace with runtime network disabled."
    ],
    inputs: ["package.json", lockfile, "tsconfig.json", "src", "tests"],
    recommendedNextMilestone: "safe disposable repair execution",
    subtasks: selectedCommands.map((command, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-external-validation`,
      goal: `Run external validation command ${index + 1}.`,
      inputs: ["package.json", lockfile, "src", "tests"],
      evidenceFocus: "External repository validation result.",
      evidenceCommand: command
    }))
  };
}

export function planCampaignFromGoal(campaignId: string, spec: CampaignSpec): CampaignPlan {
  const draft = planTaskRun(spec.goal);
  const selected = draft.subtasks.slice(0, Math.max(1, Math.min(spec.limits.maxTasks, draft.subtasks.length || 1)));
  const model = spec.providerRouting.phaseModels?.implementer ?? spec.providerRouting.model ?? "openrouter/auto";
  const perNodeTokens = Math.max(1, Math.floor(spec.limits.maxTokens / Math.max(1, selected.length)));
  const nodes: CampaignPlanNode[] = selected.map((subtask, index) => {
    const childId = `${campaignId}_${String(index + 1).padStart(2, "0")}`;
    const executionMode = spec.authority.implementation ? "implementation" : "inspection";
    const phaseModels = spec.providerRouting.phaseModels ?? { planner: model, implementer: model, repair: model, reviewer: model };
    return {
      id: subtask.id,
      dependsOn: index === 0 ? [] : [selected[index - 1]!.id],
      estimatedTokens: perNodeTokens,
      ...(spec.limits.maxCostUsd === undefined ? {} : { estimatedCostUsd: spec.limits.maxCostUsd / Math.max(1, selected.length) }),
      taskSpec: {
        schemaVersion: 2,
        taskId: childId.slice(0, 80),
        task: { text: subtask.goal, goal: spec.goal, acceptanceCriteria: [subtask.evidenceFocus || "Produce bounded implementation evidence."] },
        target: {
          repository: spec.target.repository ?? ".",
          workingDirectory: spec.target.workingDirectory ?? ".",
          ...(spec.target.expectedSha ? { expectedSha: spec.target.expectedSha } : {})
        },
        execution: {
          mode: executionMode,
          maxRepairIterations: 1,
          timeoutMs: 120_000,
          maxChangedFiles: 20,
          maxPatchBytes: 500_000,
          maxProviderTokens: Math.max(1_000, Math.min(200_000, perNodeTokens)),
          budgetMode: "hard",
          phaseBudgets: { startup: 100, analysis: 300, implementation: Math.max(200, perNodeTokens - 900), validation: 200, repair: 200, review: 100, publication: 0 }
        },
        providerRouting: {
          provider: spec.providerRouting.provider,
          models: phaseModels,
          maxCalls: 1,
          tokenBudget: { total: Math.max(1_000, perNodeTokens), perPhase: { planner: 200, implementer: Math.max(400, perNodeTokens - 400), repair: 200, reviewer: 200 } },
          timeoutMs: 120_000,
          retry: { maxAttempts: 1 },
          ...(spec.limits.maxCostUsd === undefined ? {} : { costBudgetUsd: spec.limits.maxCostUsd }),
          fallbackPolicy: spec.providerRouting.provider === "openrouter" ? "none" : spec.providerRouting.fallbackPolicy ?? "same_provider"
        },
        authority: { profile: executionMode === "implementation" ? "bounded-implementation" : "read-only", envelopeFile: null, forbiddenAreas: ["merge", "deploy", "database", "production", "secrets"], allowProviderCalls: Boolean(spec.authority.providerCalls), allowNetwork: Boolean(spec.authority.network) },
        runtime: { preference: "local-disposable", dockerImage: "runforge:local", dependencyPreparation: "if-needed", externalNetwork: spec.authority.network ? "allowed" : "denied" },
        git: { publication: "none", branch: null },
        merge: { policy: "never" },
        deploy: { policy: "never" },
        discovery: { policy: "auto", profile: "small-scope", explicitFiles: [], maxFiles: 30, maxBytes: 400_000, maxTokens: 30_000, stopCondition: "Stop once sufficient scoped evidence is collected." },
        validation: { mode: "auto", commands: [], requirements: [] },
        ownerGate: { policy: "stop-and-report" },
        repair: { mode: "none", plan: null },
        artifacts: { root: `/tmp/runforge-campaign/${childId}`, resultFormat: "normalized-v1" }
      }
    };
  });
  return { schemaVersion: 1, campaignId, nodes, estimatedTokens: nodes.reduce((n, item) => n + (item.estimatedTokens ?? 0), 0), ...(spec.limits.maxCostUsd === undefined ? {} : { estimatedCostUsd: nodes.reduce((n, item) => n + (item.estimatedCostUsd ?? 0), 0) }) };
}

export function detectCycle(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const visiting = new Set<string>(), visited = new Set<string>(), stack: string[] = [], graph = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const walk = (id: string): string[] => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return [];
    visiting.add(id); stack.push(id);
    for (const dep of graph.get(id) ?? []) { const found = walk(dep); if (found.length) return found; }
    stack.pop(); visiting.delete(id); visited.add(id); return [];
  };
  for (const node of nodes) { const cycle = walk(node.id); if (cycle.length) return cycle; }
  return [];
}

export function topoSortPlan(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const deps = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)])), ready = [...nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)], ordered: string[] = [];
  while (ready.length) { const id = ready.shift()!; ordered.push(id); for (const [otherId, otherDeps] of deps) if (otherDeps.delete(id) && otherDeps.size === 0) ready.push(otherId); }
  return ordered;
}

export function validateCampaignPlan(plan: CampaignPlan, limits: { maxTasks: number; maxTokens: number; maxCostUsd?: number }, authority: ControlAuthority, options: { requireOpenRouter: boolean }): void {
  const ids = new Set<string>(); if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error("campaign plan must include at least one node.");
  if (plan.nodes.length > limits.maxTasks) throw new Error("campaign plan exceeds maxTasks.");
  for (const node of plan.nodes) { if (ids.has(node.id)) throw new Error(`duplicate campaign node id: ${node.id}`); ids.add(node.id); for (const dep of node.dependsOn) if (!plan.nodes.some((item) => item.id === dep)) throw new Error(`campaign dependency is missing: ${dep}`); const task = node.taskSpec as Record<string, any>; const taskAuthority = task.authority ?? {}; if (taskAuthority.allowProviderCalls && authority.providerCalls !== true) throw new Error(`campaign authority expansion rejected for node ${node.id}: providerCalls`); if (taskAuthority.allowNetwork && authority.network !== true) throw new Error(`campaign authority expansion rejected for node ${node.id}: network`); if (object(task.merge).policy && object(task.merge).policy !== "never") throw new Error(`dangerous phase requested in node ${node.id}: merge`); if (object(task.deploy).policy && object(task.deploy).policy !== "never") throw new Error(`dangerous phase requested in node ${node.id}: deploy`); if (object(task.git).publication && object(task.git).publication !== "none") throw new Error(`dangerous phase requested in node ${node.id}: publication`); const text = JSON.stringify(task).toLowerCase(); if (/\b(?:database|production|secret|merge|deploy)\b/.test(text) && /\bpolicy"\s*:\s*"always|requested"\s*:\s*true/.test(text)) throw new Error(`dangerous requested phase in node ${node.id}`); if (options.requireOpenRouter) { const route = object(task.providerRouting); if (route.provider !== "openrouter") throw new Error(`openrouter campaign node ${node.id} attempted local provider.`); if ((route.fallbackPolicy ?? "none") !== "none") throw new Error(`openrouter campaign node ${node.id} attempted fallback expansion.`); } }
  const cycle = detectCycle(plan.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn }))); if (cycle.length) throw new Error(`campaign plan has cycle: ${cycle.join(" -> ")}`);
  const estimatedTokens = plan.nodes.reduce((total, node) => total + (node.estimatedTokens ?? 0), 0); if (estimatedTokens > limits.maxTokens) throw new Error("campaign token budget exceeded by planned estimate.");
  const estimatedCost = plan.nodes.reduce((total, node) => total + (node.estimatedCostUsd ?? 0), 0); if (limits.maxCostUsd !== undefined && estimatedCost > limits.maxCostUsd) throw new Error("campaign cost budget exceeded by planned estimate.");
}

function classifyTask(task: string): TaskKind {
  const normalized = task.toLowerCase();
  const docsScore = score(normalized, ["doc", "roadmap", "contradiction", "milestone", "non-goal", "current state"]);
  const codeScore = score(normalized, ["code", "harness", "implementation", "typescript", "test", "cli", "renderer", "docker", "runtime", "executor", "isolation"]);
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
  if (asksForDockerRuntime(task)) return dockerRuntimeCodePlan();
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

function dockerRuntimeCodePlan(): TaskRunPlan {
  const milestone = "external-repo check/triage through Docker runtime";
  return {
    kind: "code-inspection",
    planningBasis: [
      "Task asks for a concrete isolated runtime implementation.",
      "Use CLI wiring, executor policy, container build, tests, and owner-visible artifacts as primary evidence."
    ],
    inputs: [
      "src/cli/commands/task-run.ts",
      "src/run/task-run-harness.ts",
      "src/run/task-run-executor.ts",
      "src/run/task-run-renderer.ts",
      "docker/Dockerfile",
      "tests/unit/task-run-executor.test.ts"
    ],
    recommendedNextMilestone: milestone,
    subtasks: [
      {
        id: "01-runtime-cli-and-dispatch",
        goal: "Verify explicit local/Docker runtime selection reaches executor dispatch.",
        inputs: ["src/cli/commands/task-run.ts", "src/run/task-run-harness.ts"],
        evidenceFocus: "Runtime CLI contract, safe default, and executor selection.",
        evidenceCommand: "rg -n \"runtime|docker-image|DockerShellExecutor|LocalShellExecutor|executor.lane\" src/cli/commands/task-run.ts src/run/task-run-harness.ts"
      },
      {
        id: "02-container-safety-policy",
        goal: "Verify the Docker lane is offline, read-only, bounded, and uses a prebuilt image.",
        inputs: ["src/run/task-run-executor.ts", "docker/Dockerfile"],
        evidenceFocus: "Container mount, network, privilege, resource, image, and timeout controls.",
        evidenceCommand: "rg -n \"pull|network|cap-drop|read-only|pids-limit|memory|cpus|tmpfs|readonly|removeContainer|FROM|ripgrep\" src/run/task-run-executor.ts docker/Dockerfile"
      },
      {
        id: "03-runtime-evidence-contract",
        goal: "Verify runtime metadata is tested and rendered into owner-visible artifacts.",
        inputs: ["src/run/task-run-renderer.ts", "tests/unit/task-run-executor.test.ts", "tests/unit/task-run-renderer.test.ts"],
        evidenceFocus: "Runtime metadata in summaries/results and regression coverage.",
        evidenceCommand: "rg -n \"Runtime mode|containerUsed|docker-shell|dockerRunArgs|network.*none|runtime\" src/run/task-run-renderer.ts tests/unit/task-run-executor.test.ts tests/unit/task-run-renderer.test.ts"
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

function asksForDockerRuntime(task: string): boolean {
  const normalized = task.toLowerCase();
  return normalized.includes("docker") || normalized.includes("container runtime") || normalized.includes("container isolation");
}

function score(value: string, terms: string[]): number {
  return terms.reduce((total, term) => {
    const matched = term === "doc" ? /\bdocs?\b/.test(value) : value.includes(term);
    return total + (matched ? 1 : 0);
  }, 0);
}
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
