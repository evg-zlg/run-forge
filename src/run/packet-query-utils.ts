import { basename } from "node:path";

export function latestMilestone(milestones: string[]): string {
  const sorted = [...new Set(milestones)].sort((a, b) => milestoneNumber(a) - milestoneNumber(b) || a.localeCompare(b));
  return sorted.at(-1) ?? "unknown";
}

export function repoName(repo: string): string {
  if (repo === "unknown") return repo;
  return basename(repo);
}

export function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function milestoneNumber(milestone: string): number {
  const match = /^ALPHA-(\d+)/.exec(milestone);
  return match ? Number(match[1]) : -1;
}
