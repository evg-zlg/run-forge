import type { FailureClassification, FailureCategory } from "../core/types.js";

const patterns: Array<{ category: FailureCategory; confidence: "medium" | "high"; regex: RegExp }> = [
  { category: "typecheck_failure", confidence: "high", regex: /\bTS\d{4}\b|Type error|tsc/i },
  { category: "test_failure", confidence: "high", regex: /\bFAIL\b|AssertionError|expected|received|vitest|jest/i },
  { category: "dependency_failure", confidence: "medium", regex: /ERR_PNPM|npm ERR|lockfile|peer dependency/i },
  { category: "env_config_failure", confidence: "medium", regex: /Missing environment variable|\.env|ENOENT|Cannot find module|not found/i },
  { category: "build_failure", confidence: "medium", regex: /build failed|webpack|vite build|rollup|esbuild/i },
  { category: "infra_timeout_failure", confidence: "medium", regex: /timeout|ECONNRESET|network|rate limit/i }
];

export function classifyFailure(logText: string): FailureClassification {
  const signals: string[] = [];
  for (const pattern of patterns) {
    const match = logText.match(pattern.regex);
    if (match) {
      signals.push(match[0]);
      return { category: pattern.category, confidence: pattern.confidence, signals };
    }
  }
  return { category: "unknown_failure", confidence: "low", signals };
}
