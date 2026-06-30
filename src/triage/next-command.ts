import type { FailureCategory, RepoInspection } from "../core/types.js";

export function chooseSafeNextCommand(category: FailureCategory, repo: RepoInspection): string | undefined {
  const runner = repo.packageManager === "unknown" ? "pnpm" : repo.packageManager;
  if (category === "typecheck_failure" && repo.scripts.typecheck) return `${runner} run typecheck`;
  if (category === "test_failure") {
    if (repo.scripts.test) return `${runner} test`;
    if (repo.scripts.vitest) return `${runner} run vitest`;
  }
  if (category === "build_failure" && repo.scripts.build) return `${runner} run build`;
  if (category === "dependency_failure") return `${runner} install --frozen-lockfile`;
  if (category === "env_config_failure") return "node -e \"console.log('Check required env vars in README.md or .env.example')\"";
  return undefined;
}
