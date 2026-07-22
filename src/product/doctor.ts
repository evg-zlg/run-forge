import { platform } from "node:os";
import { resolve } from "node:path";
import { runForgeVersion } from "../core/version.js";
import { runningInContainer, unsafeMountWarnings } from "../security/docker-policy.js";
import { commandVersion, defaultArtifactRoot, inspectProject, isPathInside, type ReadinessCheck } from "./project-inspection.js";
import { discoverImplementationExecutors, type ImplementationExecutorCapability } from "../implementation/executor.js";
import { openRouterPricingCatalogStatus, type OpenRouterPricingCatalogStatus } from "../providers/openrouter-pricing.js";

export type DoctorOptions = { repo?: string; workingDirectory?: string; artifactRoot?: string; runtime?: "local" | "docker"; dependencyPreparation?: "required" | "if-needed" | "disabled" | "reuse-existing"; dockerImage?: string; publication?: "none" | "draft-pr" };
export type DoctorReport = {
  schemaVersion: 1;
  product: "RunForge";
  runforgeVersion: string;
  status: "ready" | "ready_with_warnings" | "blocked";
  runtime: { node: string; pnpm: string | null; docker: string | null; os: string; insideContainer: boolean };
  targetRepository: Awaited<ReturnType<typeof inspectProject>> | null;
  artifactRoot: { path: string | null; outsideTargetRepository: boolean | null };
  integrations: { dockerRequired: boolean; githubRequired: boolean; databaseRequired: false; productionRequired: false; secretsRequired: false };
  implementationExecutors: ImplementationExecutorCapability[];
  openRouterPricingCatalog: OpenRouterPricingCatalogStatus;
  checks: ReadinessCheck[];
  nextAction: { command: string | null; reason: string };
};

export async function buildDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const [pnpm, docker, implementationExecutors] = await Promise.all([commandVersion("pnpm", ["--version"]), commandVersion("docker", ["--version"]), discoverImplementationExecutors()]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const dockerRequired = options.runtime === "docker";
  const dockerImage = options.dockerImage ?? "runforge:local";
  const githubRequired = options.publication === "draft-pr";
  const checks: ReadinessCheck[] = [
    check("runforge", true, true, `RunForge ${runForgeVersion} starts successfully.`),
    check("node", nodeMajor >= 20, true, nodeMajor >= 20 ? `Node ${process.version} satisfies >=20.` : `Node ${process.version} is unsupported; >=20 is required.`),
    pnpm ? check("pnpm", true, false, `pnpm ${pnpm} is available.`) : { id: "pnpm", status: "warning", required: false, summary: "pnpm is unavailable; installed CLI use remains ready, but source-checkout commands require corepack/pnpm." }
  ];
  checks.push(implementationExecutors.some((item) => item.status === "ready")
    ? check("implementation_executor", true, false, `Ready implementation executor(s): ${implementationExecutors.filter((item) => item.status === "ready").map((item) => item.id).join(", ")}.`)
    : { id: "implementation_executor", status: "warning", required: false, summary: `Implementation tasks are unavailable: ${implementationExecutors.flatMap((item) => item.limitations).join("; ")}` });
  const openRouterPricingCatalog = openRouterPricingCatalogStatus();
  checks.push({ id: "openrouter_capped_campaign_pricing", status: openRouterPricingCatalog.catalogValid ? "passed" : "not_required", required: false, summary: openRouterPricingCatalog.message });
  const target = options.repo ? await inspectProject(options.repo, options.workingDirectory ?? ".") : null;
  if (target) {
    checks.push(check("target_path", target.exists, true, target.exists ? `Target path exists: ${target.path}` : `Target path does not exist: ${target.requestedPath}`));
    checks.push(check("target_git", target.isGitRepository, true, target.isGitRepository ? "Target is a Git repository." : "Target is not a Git repository."));
    if (target.isGitRepository) {
      checks.push(check("target_head", target.head !== null, true, target.head ? `Target HEAD is ${target.head}.` : "Target has no committed HEAD."));
      checks.push(target.worktree.clean === false
        ? { id: "target_worktree", status: "warning", required: false, summary: "Target worktree is dirty; existing changes must be preserved.", details: { porcelain: target.worktree.summary } }
        : check("target_worktree", true, false, "Target worktree is clean."));
      checks.push(target.detachedHead
        ? { id: "target_branch", status: "warning", required: false, summary: `Target is at detached HEAD ${target.head}; read-only tasks remain possible.` }
        : check("target_branch", true, false, `Target branch is ${target.branch}.`));
      checks.push(target.packageManager
        ? check("package_manager", true, false, `Detected package manager: ${target.packageManager}.`)
        : { id: "package_manager", status: "warning", required: false, summary: "No supported JavaScript package manager was detected; provide explicit validation commands." });
      checks.push(target.validationCommands.length
        ? check("validation_commands", true, false, `Discovered: ${target.validationCommands.join(", ")}.`)
        : { id: "validation_commands", status: "warning", required: false, summary: "No standard validation commands were discovered; provide them in TaskSpec v2." });
      const preparationRequired = options.dependencyPreparation === "required";
      checks.push(preparationRequired
        ? check("dependency_preparation", target.dependencyPreparation.supported, true, target.dependencyPreparation.supported ? `Dependency preparation is supported by ${target.dependencyPreparation.lockfile}.` : "Required dependency preparation needs package-lock.json, pnpm-lock.yaml, or yarn.lock in the execution root.")
        : { id: "dependency_preparation", status: target.dependencyPreparation.supported ? "passed" : "warning", required: false, summary: target.dependencyPreparation.supported ? `Dependency preparation is available from ${target.dependencyPreparation.lockfile}; strategy is ${options.dependencyPreparation ?? "if-needed"}.` : `No supported lockfile was detected in the execution root; strategy ${options.dependencyPreparation ?? "if-needed"} can still run when validation does not need installation.` });
    }
  }
  const artifactPath = target?.path ? resolve(options.artifactRoot ?? defaultArtifactRoot(target.path)) : options.artifactRoot ? resolve(options.artifactRoot) : null;
  const outside = target?.path && artifactPath ? !(await isPathInside(target.path, artifactPath)) : null;
  if (target?.isGitRepository && artifactPath) checks.push(check("artifact_root", outside === true, true, outside ? `Artifact root is outside target: ${artifactPath}` : `Artifact root must be outside target repository: ${artifactPath}`));
  const [dockerDaemon, dockerImageId] = dockerRequired && docker
    ? await Promise.all([commandVersion("docker", ["info", "--format", "{{.ServerVersion}}"]), commandVersion("docker", ["image", "inspect", dockerImage, "--format", "{{.Id}}"])])
    : [null, null];
  checks.push(dockerRequired
    ? check("docker", docker !== null && dockerDaemon !== null && dockerImageId !== null, true, docker === null ? "Docker CLI is required by the requested runtime but unavailable." : dockerDaemon === null ? "Docker daemon is unavailable or inaccessible." : dockerImageId === null ? `Required local Docker image is unavailable: ${dockerImage}.` : `Docker daemon and image ${dockerImage} are ready.`)
    : { id: "docker", status: docker ? "passed" : "not_required", required: false, summary: docker ? `Docker is available: ${docker}` : "Docker is unavailable but not required for this readiness check." });
  const gh = githubRequired ? await commandVersion("gh", ["auth", "status"]) : null;
  checks.push(githubRequired
    ? check("github", gh !== null, true, gh ? "GitHub authentication is ready for requested draft publication." : "GitHub authentication is required for requested draft publication.")
    : { id: "github", status: "not_required", required: false, summary: "GitHub is not required because publication was not requested." });
  const mountWarnings = unsafeMountWarnings();
  if (mountWarnings.length) checks.push({ id: "mounts", status: "warning", required: false, summary: mountWarnings.join("; ") });
  const status = checks.some((item) => item.status === "blocked") ? "blocked" : checks.some((item) => item.status === "warning") ? "ready_with_warnings" : "ready";
  const nextCommand = target?.isGitRepository && artifactPath && status !== "blocked"
    ? `runforge task-run start --spec /absolute/path/to/task.runforge.json`
    : null;
  return {
    schemaVersion: 1, product: "RunForge", runforgeVersion: runForgeVersion, status,
    runtime: { node: process.version, pnpm, docker, os: platform(), insideContainer: runningInContainer() },
    targetRepository: target,
    artifactRoot: { path: artifactPath, outsideTargetRepository: outside },
    integrations: { dockerRequired, githubRequired, databaseRequired: false, productionRequired: false, secretsRequired: false }, implementationExecutors, openRouterPricingCatalog,
    checks,
    nextAction: { command: nextCommand, reason: nextCommand ? "Create a TaskSpec v2 using the discovered repository contract." : "Resolve blocking readiness checks first." }
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [`RunForge doctor: ${report.status}`, `Version: ${report.runforgeVersion}`, `Node: ${report.runtime.node}`, `pnpm: ${report.runtime.pnpm ?? "not available"}`];
  if (report.targetRepository) lines.push(`Repository root: ${report.targetRepository.repositoryRoot ?? report.targetRepository.requestedPath}`, `Execution root: ${report.targetRepository.executionRoot ?? "not resolved"}`, `Git: ${report.targetRepository.isGitRepository ? `${report.targetRepository.branch ?? "detached"} @ ${report.targetRepository.head}` : "not a repository"}`, `Worktree: ${report.targetRepository.worktree.clean === false ? "dirty (preserved; warning)" : report.targetRepository.worktree.clean === true ? "clean" : "unknown"}`, `Package manager: ${report.targetRepository.packageManager ?? "not detected"}`, `Lockfile: ${report.targetRepository.dependencyPreparation.lockfile ?? "not detected"}`, `Validation: ${report.targetRepository.validationCommands.join(", ") || "provide explicitly"}`, `Artifacts: ${report.artifactRoot.path ?? "not resolved"}`);
  lines.push(`Implementation executors: ${report.implementationExecutors.map((item) => `${item.id}=${item.status}`).join(", ")}`);
  lines.push(`OpenRouter capped campaigns: ${report.openRouterPricingCatalog.message}`);
  for (const item of report.checks.filter((value) => ["warning", "blocked"].includes(value.status))) lines.push(`${item.status.toUpperCase()}: ${item.summary}`);
  if (report.nextAction.command) lines.push(`Next: ${report.nextAction.command}`);
  return lines.join("\n");
}

function check(id: string, passed: boolean, required: boolean, summary: string): ReadinessCheck {
  return { id, status: passed ? "passed" : required ? "blocked" : "warning", required, summary };
}
