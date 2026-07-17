import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getRunForgeVersionInfo, runForgeRoot, runForgeVersion } from "../core/version.js";
import { defaultArtifactRoot, inspectProject } from "./project-inspection.js";

export type OnboardingReport = {
  schemaVersion: 1;
  product: "RunForge";
  description: string;
  runforgeVersion: string;
  versionInfo: ReturnType<typeof getRunForgeVersionInfo>;
  transport: "local-cli";
  entrypoint: "runforge";
  installation: { root: string };
  recommendedWorkflow: string[];
  supportedInterfaces: string[];
  unsupportedInterfaces: string[];
  commands: { onboarding: string; doctor: string; submitTask: string; continueTask: string; ownerDecision: string };
  contracts: { onboarding: string; doctor: string; taskSpec: string; result: string; projectFile: string };
  artifactContract: { schemaVersion: 1; primaryFiles: ["summary.md", "results.json"]; resultSchema: string };
  safetyDefaults: Record<string, boolean | string>;
  taskSpecTemplate: Record<string, unknown>;
  targetRepository: Awaited<ReturnType<typeof inspectProject>> | null;
  projectFile: { path: string | null; exists: boolean; writeRequested: boolean; written: boolean };
  nextAction: { command: string; purpose: string };
};

export async function buildOnboardingReport(input: { repo?: string; workingDirectory?: string; writeProjectFile?: boolean }): Promise<OnboardingReport> {
  const target = input.repo ? await inspectProject(input.repo, input.workingDirectory ?? ".") : null;
  const projectPath = target?.path ? join(target.path, "RUNFORGE.md") : null;
  let written = false;
  if (input.writeProjectFile) {
    if (!target?.isGitRepository || !target.path || !projectPath) throw new Error("--write-project-file requires --repo pointing to a Git repository.");
    await writeFile(projectPath, renderProjectFile(target), { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error(`Refusing to overwrite existing project file: ${projectPath}`);
      throw error;
    });
    written = true;
  }
  const exists = projectPath ? await access(projectPath).then(() => true, () => false) : false;
  const doctor = target?.path ? `runforge doctor --repo ${shellQuote(target.path)} --working-directory ${shellQuote(target.workingDirectory ?? ".")} --runtime docker --format json` : "runforge doctor --repo /absolute/path/to/project --working-directory . --runtime docker --format json";
  return {
    schemaVersion: 1,
    product: "RunForge",
    description: "A local, artifact-first engineering task harness with explicit safety and owner gates.",
    runforgeVersion: runForgeVersion,
    versionInfo: getRunForgeVersionInfo(),
    transport: "local-cli",
    entrypoint: "runforge",
    installation: { root: runForgeRoot() },
    recommendedWorkflow: ["onboarding", "doctor", "create TaskSpec v2", "task-run start", "read results.json and summary.md", "handle owner gate if present"],
    supportedInterfaces: ["local CLI", "read-only project discovery", "project readiness checks", "TaskSpec v2 intake", "normalized result artifacts", "explicit owner decisions", "legacy run and task-run commands"],
    unsupportedInterfaces: ["HTTP API", "remote daemon", "MCP server", "watched filesystem queue", "hosted/Admin service", "deploy automation", "automatic target PR merge"],
    commands: {
      onboarding: "runforge onboarding --format json",
      doctor,
      submitTask: "runforge task-run start --spec /absolute/path/to/task.runforge.json",
      continueTask: "runforge task-run continue --run /absolute/path/to/artifact-root",
      ownerDecision: "runforge task-run owner-decision --run /absolute/path/to/artifact-root --decision approve --target-mode controlled-worktree --target-branch codex/task-id --note \"approved\""
    },
    contracts: {
      onboarding: "docs/contracts/onboarding-v1.md",
      doctor: "docs/contracts/doctor-v1.md",
      taskSpec: "schemas/task-spec-v2.schema.json",
      result: "schemas/task-result-v1.schema.json",
      projectFile: "docs/contracts/runforge-project-file.md"
    },
    artifactContract: { schemaVersion: 1, primaryFiles: ["summary.md", "results.json"], resultSchema: "schemas/task-result-v1.schema.json" },
    safetyDefaults: { targetMainMutation: false, targetMainPush: false, targetPrMerge: false, deploy: false, databaseAccess: false, productionAccess: false, secretAccess: false, providerCalls: false, artifactsOutsideTarget: true, ownerGateRequiredForApply: true },
    taskSpecTemplate: minimalTaskSpec(target?.path ?? "/absolute/path/to/project", target?.workingDirectory ?? "."),
    targetRepository: target,
    projectFile: { path: projectPath, exists, writeRequested: input.writeProjectFile === true, written },
    nextAction: { command: doctor, purpose: target ? "Verify target readiness, then create TaskSpec v2." : "Supply a target repository and verify readiness." }
  };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function minimalTaskSpec(repository: string, workingDirectory: string): Record<string, unknown> {
  return {
    schemaVersion: 2, taskId: "PROJECT-TASK-1",
    task: { text: "Describe the engineering task.", goal: "Describe the product outcome.", acceptanceCriteria: ["State one observable acceptance criterion."] },
    target: { repository, workingDirectory }, runtime: { preference: "docker", dependencyPreparation: "if-needed", externalNetwork: "denied" },
    validation: { mode: "auto", commands: [] }, authority: { profile: "read-only", allowProviderCalls: false },
    git: { publication: "none" }, merge: { policy: "never" }, deploy: { policy: "never" }, ownerGate: { policy: "stop-and-report" }
  };
}

export function renderOnboarding(report: OnboardingReport): string {
  return [
    `RunForge ${report.runforgeVersion} — local CLI for safe, artifact-first engineering tasks.`,
    `Transport: ${report.transport}; entrypoint: ${report.entrypoint}`,
    "Workflow: onboarding → doctor → TaskSpec v2 → task-run → results.json/summary.md → owner gate if needed.",
    `Supported: ${report.supportedInterfaces.slice(0, 5).join(", ")}.`,
    `Not available: ${report.unsupportedInterfaces.join(", ")}.`,
    `Repository root: ${report.targetRepository?.repositoryRoot ?? "not supplied"}`,
    `Execution root: ${report.targetRepository?.executionRoot ?? "not supplied"}`,
    `Artifacts: ${report.targetRepository?.path ? defaultArtifactRoot(report.targetRepository.path) : "outside the target repository"}`,
    `Owner gate: only when results.json reports awaiting_owner_decision, record an explicit decision and then use '${report.commands.continueTask}'; otherwise follow nextAction.`,
    `Next: ${report.nextAction.command}`
  ].join("\n");
}

function renderProjectFile(target: NonNullable<OnboardingReport["targetRepository"]>): string {
  const validations = target.validationCommands.length ? target.validationCommands.map((command) => `- \`${command}\``).join("\n") : "- Define explicit safe commands in TaskSpec v2.";
  return `# RunForge project contract

This file contains project-specific defaults only. Discover the product contract with \`runforge onboarding --format json\`.

- RunForge locator: \`${runForgeRoot()}\`
- Target repository: \`${target.path}\`
- Target identity at generation: \`${target.head}\`
- Default branch: \`${target.defaultBranch ?? "unknown"}\`
- Artifact root: \`${defaultArtifactRoot(target.path!)}\` (outside this repository)
- Authority default: read-only discovery and validation; writes require explicit bounded authority and owner gates.
- Forbidden zones: target main push/mutation, PR merge, deploy, DB, production, secrets, migrations.
- CI/publication: not requested by default; GitHub readiness is checked only when publication is requested.
- Merge/deploy: never automatic.

## Safe validation commands

${validations}

## Additional project gates

- Add concise project-specific gates here when needed.
`;
}

export async function readProjectFile(repo: string): Promise<string | null> {
  return readFile(join(resolve(repo), "RUNFORGE.md"), "utf8").catch(() => null);
}
