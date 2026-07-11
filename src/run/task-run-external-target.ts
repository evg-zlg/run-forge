import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { blockedCommandReports } from "./external-command-check-helpers.js";
import { gitSnapshot, mutationVerdictFor } from "./external-command-check-git.js";
import type { GitSnapshot } from "./external-command-check-types.js";
import type { CheckResult, TaskRunRuntime } from "./task-run-harness.js";

export type ExternalClassification = "passed" | "deterministic failure" | "environment/setup issue" | "unsafe/not runnable" | "needs owner approval";

export async function prepareExternalTarget(input: {
  repo?: string;
  runtime: TaskRunRuntime;
  delegatedReview?: "mock" | "cli";
  commands?: string[];
}): Promise<{ repo: string; commands: string[]; before: GitSnapshot } | undefined> {
  if (!input.repo) return undefined;
  const repo = resolve(input.repo);
  if (input.runtime !== "docker") throw new Error("--repo requires --runtime docker.");
  if (input.delegatedReview) throw new Error("External task-run uses providerless deterministic review; delegated review is not allowed.");
  const info = await stat(repo).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`--repo must be an existing directory: ${repo}`);
  const commands = input.commands?.length ? input.commands : ["npm run typecheck", "npm test", "npm run build"];
  const blocked = blockedCommandReports(commands, "main");
  if (blocked[0]) throw new Error(blocked[0].reason);
  return { repo, commands, before: await gitSnapshot(repo) };
}

export async function finishExternalTarget(
  prepared: { repo: string; commands: string[]; before: GitSnapshot },
  checks: CheckResult[]
): Promise<{
  after: GitSnapshot;
  mutationVerdict: "unchanged" | "changed" | "unknown";
  capabilityClassification: ExternalClassification;
  targetClassification: ExternalClassification;
}> {
  const after = await gitSnapshot(prepared.repo);
  const mutationVerdict = mutationVerdictFor(prepared.before, after);
  return {
    after,
    mutationVerdict,
    capabilityClassification: mutationVerdict === "changed" ? "unsafe/not runnable" : "passed",
    targetClassification: classifyTarget(checks)
  };
}

export function assertExternalArtifactsOutsideTarget(repo: string, paths: string[]): void {
  for (const path of paths) {
    const fromTarget = relative(repo, resolve(path));
    if (fromTarget === "" || (fromTarget !== ".." && !fromTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromTarget))) {
      throw new Error(`External task-run artifacts and tmp workspaces must be outside --repo: ${path}`);
    }
  }
}

function classifyTarget(checks: CheckResult[]): ExternalClassification {
  if (checks.every((check) => check.result === "passed")) return "passed";
  const diagnostic = checks.map((check) => `${check.stdout}\n${check.stderr}`).join("\n");
  if (/optional dependency|Cannot find module.*rollup|MODULE_NOT_FOUND|unsupported platform|not found|ENOENT/i.test(diagnostic)) return "environment/setup issue";
  return "deterministic failure";
}
