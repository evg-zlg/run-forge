export type ProjectKind = "cli-tooling" | "frontend-app" | "fullstack-app" | "db-sensitive" | "unknown";
export type CandidateRisk = "safe-docs" | "safe-test" | "safe-utility" | "safe-cli-validation" | "frontend-only" | "auth-sensitive" | "db-sensitive" | "prod-sensitive" | "migration-sensitive" | "unknown";
export type CandidateDecision = "draft-pr-allowed" | "patch-package-only" | "read-only-triage" | "needs-owner-decision" | "rejected-risk" | "duplicate-existing";

export type CandidateAuthorityInput = {
  files: string[];
  projectKind: ProjectKind;
  allowedFilePatterns: string[];
  forbiddenFilePatterns: string[];
  publicationPermission: string;
  publicationActionsCovered: boolean;
  validationConfidence: "high" | "low";
  duplicateExisting: boolean;
};

const hardForbidden = ["**/.env*", "**/secrets/**", "**/migrations/**", "**/deploy/**", "**/infra/**"];

export function classifyCandidateFiles(files: string[]): CandidateRisk {
  if (!files.length) return "unknown";
  if (files.some((file) => matchesAny(file, ["**/migrations/**"]))) return "migration-sensitive";
  if (files.some((file) => matchesAny(file, ["**/auth/**", "auth/**", "**/*auth*fixture*"]))) return "auth-sensitive";
  if (files.some((file) => matchesAny(file, ["**/db/**", "db/**", "**/database/**", "**/prisma/**", "**/*.sql"]))) return "db-sensitive";
  if (files.some((file) => matchesAny(file, ["**/deploy/**", "**/infra/**", "**/production/**", "**/prod/**", ".github/workflows/**"]))) return "prod-sensitive";
  if (files.every((file) => /(^|\/)(docs?|README)/i.test(file) || /\.md$/i.test(file))) return "safe-docs";
  if (files.every((file) => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(file))) return "safe-test";
  if (files.every((file) => /(^|\/)(cli|cmd|commands|bin)(\/|$)/i.test(file))) return "safe-cli-validation";
  if (files.every((file) => /(^|\/)(src\/lib|lib|utils?|src\/utils?)(\/|$)/i.test(file))) return "safe-utility";
  if (files.every((file) => /(^|\/)src\//.test(file) && /\.(ts|tsx|js|jsx|css|scss)$/.test(file))) return "frontend-only";
  return "unknown";
}

export function decideCandidateAuthority(input: CandidateAuthorityInput): { risk: CandidateRisk; decision: CandidateDecision; reason: string } {
  const risk = classifyCandidateFiles(input.files);
  if (input.duplicateExisting) return { risk, decision: "duplicate-existing", reason: "An existing PR or prior package already covers this candidate." };
  if (input.files.some((file) => matchesAny(file, [...hardForbidden, ...input.forbiddenFilePatterns]))) return { risk, decision: "rejected-risk", reason: "A forbidden file always overrides project and candidate allowlists." };
  if (["auth-sensitive", "db-sensitive", "prod-sensitive", "migration-sensitive"].includes(risk)) return { risk, decision: risk === "auth-sensitive" ? "needs-owner-decision" : "rejected-risk", reason: `${risk} files are outside automatic low-risk authority.` };
  const safelyClassified = ["safe-docs", "safe-test", "safe-utility", "safe-cli-validation", "frontend-only"].includes(risk);
  const allowed = input.files.length > 0 && input.files.every((file) => input.allowedFilePatterns.some((pattern) => patternMatches(pattern, file)));
  if (!safelyClassified || !allowed) return { risk, decision: "needs-owner-decision", reason: "Candidate files are unknown or outside the explicit candidate allowlist." };
  if (input.validationConfidence !== "high") return { risk, decision: "patch-package-only", reason: "Safe candidate lacks sufficient discovered local validation for publication." };
  if (input.projectKind === "db-sensitive") return { risk, decision: "read-only-triage", reason: "DB-sensitive repositories remain conservative without an explicit candidate publication profile." };
  if (input.publicationPermission !== "draft_pr" || !input.publicationActionsCovered) return { risk, decision: "patch-package-only", reason: "Candidate is safe, but publication authority is absent or incomplete." };
  return { risk, decision: "draft-pr-allowed", reason: "Safe candidate files, validation, and candidate-scoped publication authority all pass." };
}

export function patternMatches(pattern: string, file: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**/", "::PREFIX::").replaceAll("**", "::ALL::").replaceAll("*", "[^/]*").replaceAll("::PREFIX::", "(?:.*/)?").replaceAll("::ALL::", ".*");
  return new RegExp(`^${escaped}$`, "i").test(file);
}

function matchesAny(file: string, patterns: string[]) { return patterns.some((pattern) => patternMatches(pattern, file)); }
