/** Stable, extensible vocabulary used by validation planning and public results. */
export const VALIDATION_CAPABILITIES = [
  "filesystem", "git-metadata", "git-history", "working-tree-index", "package-manager",
  "dependencies", "shell", "network", "credentials", "docker", "local-disposable",
  "provider-model", "database", "production",
] as const;

export type ValidationCapability = (typeof VALIDATION_CAPABILITIES)[number];
export const VALIDATION_ACCEPTANCE = ["required", "optional", "advisory", "evidence-only"] as const;
export type ValidationAcceptance = (typeof VALIDATION_ACCEPTANCE)[number];
export const VALIDATION_OUTCOMES = [
  "passed", "product_failed", "setup_failed", "runtime_failed", "capability_unsupported",
  "skipped_by_policy", "timed_out", "cancelled",
] as const;
export type ValidationCommandOutcome = (typeof VALIDATION_OUTCOMES)[number];
export type ValidationAggregateStatus = "passed" | "completed_with_validation_gaps" | "blocked_by_capability" | "blocked_by_policy" | "product_failed" | "setup_failed" | "runtime_failed" | "timed_out" | "cancelled";

export type ValidationCommandRequirement = {
  command: string;
  requiredCapabilities: ValidationCapability[];
  acceptance: ValidationAcceptance;
  evidenceRole: string;
  fallbacks: string[];
  source: "explicit" | "known-command" | "auto-default";
};

export type ValidationRequirementInput = {
  command: string;
  capabilities?: ValidationCapability[];
  acceptance?: ValidationAcceptance;
  evidenceRole?: string;
  fallbacks?: string[];
};

export type ValidationProfile = {
  id: string;
  defaultAcceptance: ValidationAcceptance;
  defaultEvidenceRole: string;
  additionalCapabilities: ValidationCapability[];
};

export type ValidationProjectPolicy = {
  deniedCapabilities: ValidationCapability[];
  skippedCommands: string[];
};

export type ValidationRuntimeCapabilities = {
  runtime: "docker" | "local-disposable" | string;
  lane: string;
  available: ValidationCapability[];
};

export type ValidationPlanEntry = ValidationCommandRequirement & {
  runtime: string;
  lane: string;
  cwd: string;
  availableCapabilities: ValidationCapability[];
  missingCapabilities: ValidationCapability[];
  supported: boolean;
  reason: string;
  disposition: "execute" | "capability_unsupported" | "skipped_by_policy";
};

export type ValidationPreflightPlan = {
  schemaVersion: 1;
  createdAt: string;
  profile: ValidationProfile;
  runtime: ValidationRuntimeCapabilities;
  commands: ValidationPlanEntry[];
};

export type ValidationOutcomeRecord = {
  command: string;
  acceptance: ValidationAcceptance;
  outcome: ValidationCommandOutcome;
  exitCode: number | null;
  reason: string | null;
  evidenceRole: string;
};

export type KnownCommandDetector = {
  id: string;
  detect(command: string): Omit<ValidationCommandRequirement, "command" | "source"> | null;
};

export type PackageManagerId = "pnpm" | "npm" | "yarn" | "bun";
export type PackageManagerInvocation = { manager: PackageManagerId; launcher: PackageManagerId | "corepack" };

const packageCommand = /^(?:(corepack)\s+)?(pnpm|npm|yarn|bun)(?:\s|$)/;

export function packageManagerInvocation(command: string): PackageManagerInvocation | null {
  const match = packageCommand.exec(command.trim());
  if (!match) return null;
  const manager = match[2] as PackageManagerId;
  return { manager, launcher: match[1] === "corepack" ? "corepack" : manager };
}
const detectors: KnownCommandDetector[] = [
  {
    id: "package-script",
    detect(command) {
      return packageManagerInvocation(command) ? {
        requiredCapabilities: ["filesystem", "shell", "package-manager", "dependencies"],
        acceptance: "required", evidenceRole: "product-validation", fallbacks: [],
      } : null;
    },
  },
  {
    id: "git",
    detect(command) {
      const value = command.trim();
      if (!/^git(?:\s|$)/.test(value)) return null;
      const history = /\b(?:log|show|rev-list|merge-base|blame)\b/.test(value);
      const worktree = /\b(?:diff|status|add|reset|ls-files)\b/.test(value);
      return {
        requiredCapabilities: unique(["filesystem", "shell", "git-metadata", ...(history ? ["git-history"] as const : []), ...(worktree ? ["working-tree-index"] as const : [])]),
        acceptance: "evidence-only", evidenceRole: "git-evidence", fallbacks: [],
      };
    },
  },
  {
    id: "node",
    detect(command) {
      return /^node(?:\s|$)/.test(command.trim()) ? {
        requiredCapabilities: ["filesystem", "shell"], acceptance: "required",
        evidenceRole: "product-validation", fallbacks: [],
      } : null;
    },
  },
  {
    id: "docker",
    detect(command) {
      return /^(?:docker|docker\s+compose)(?:\s|$)/.test(command.trim()) ? {
        requiredCapabilities: ["filesystem", "shell", "docker"], acceptance: "optional",
        evidenceRole: "environment-validation", fallbacks: [],
      } : null;
    },
  },
];

export function registerKnownCommandDetector(detector: KnownCommandDetector): () => void {
  detectors.unshift(detector);
  return () => { const index = detectors.indexOf(detector); if (index >= 0) detectors.splice(index, 1); };
}

export const defaultValidationProfile = (mode: "auto" | "explicit"): ValidationProfile => ({
  id: mode === "auto" ? "auto-product-validation" : "explicit-validation",
  defaultAcceptance: "required",
  defaultEvidenceRole: "product-validation",
  additionalCapabilities: [],
});

export function normalizeValidationRequirements(input: {
  commands: readonly string[];
  mode: "auto" | "explicit";
  requirements?: readonly ValidationRequirementInput[];
  profile?: Partial<ValidationProfile>;
}): { profile: ValidationProfile; requirements: ValidationCommandRequirement[] } {
  const profile = { ...defaultValidationProfile(input.mode), ...input.profile };
  profile.additionalCapabilities = unique(profile.additionalCapabilities ?? []);
  const explicit = new Map((input.requirements ?? []).map((item) => [item.command.trim(), item]));
  for (const command of explicit.keys()) if (!input.commands.includes(command)) throw new Error(`validation.requirements references undeclared command: ${command}`);
  const requirements = input.commands.map((raw) => {
    const command = raw.trim();
    const declared = explicit.get(command);
    const known = detectors.map((detector) => detector.detect(command)).find(Boolean);
    if (declared) return {
      command,
      requiredCapabilities: unique([...(known?.requiredCapabilities ?? ["shell"]), ...(declared.capabilities ?? []), ...profile.additionalCapabilities]),
      acceptance: declared.acceptance ?? known?.acceptance ?? profile.defaultAcceptance,
      evidenceRole: declared.evidenceRole?.trim() || known?.evidenceRole || profile.defaultEvidenceRole,
      fallbacks: unique(declared.fallbacks ?? known?.fallbacks ?? []),
      source: "explicit" as const,
    };
    if (known) return { command, ...known, requiredCapabilities: unique([...known.requiredCapabilities, ...profile.additionalCapabilities]), source: "known-command" as const };
    return {
      command, requiredCapabilities: unique(profile.additionalCapabilities), acceptance: profile.defaultAcceptance,
      evidenceRole: profile.defaultEvidenceRole, fallbacks: [], source: "auto-default" as const,
    };
  });
  return { profile, requirements };
}

export function buildValidationPreflightPlan(input: {
  requirements: readonly ValidationCommandRequirement[];
  profile: ValidationProfile;
  policy?: Partial<ValidationProjectPolicy>;
  runtime: ValidationRuntimeCapabilities;
  cwd: string;
  now?: Date;
}): ValidationPreflightPlan {
  const denied = new Set(input.policy?.deniedCapabilities ?? []);
  const skipped = new Set(input.policy?.skippedCommands ?? []);
  const available = new Set(input.runtime.available);
  return {
    schemaVersion: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    profile: input.profile,
    runtime: { ...input.runtime, available: unique([...available]) },
    commands: input.requirements.map((requirement) => {
      const missing = requirement.requiredCapabilities.filter((capability) => !available.has(capability));
      const policySkipped = skipped.has(requirement.command) || requirement.requiredCapabilities.some((capability) => denied.has(capability));
      const known = requirement.source !== "auto-default" || requirement.requiredCapabilities.length > 0;
      const supported = known && missing.length === 0 && !policySkipped;
      const disposition = policySkipped ? "skipped_by_policy" : supported ? "execute" : "capability_unsupported";
      const reason = policySkipped ? "Project policy skips the command or denies a required capability."
        : !known ? "No known-command detector or explicit capability requirement describes this command."
          : missing.length ? `Missing capabilities: ${missing.join(", ")}.` : "All required capabilities are available.";
      return { ...requirement, runtime: input.runtime.runtime, lane: input.runtime.lane, cwd: input.cwd, availableCapabilities: unique([...available]), missingCapabilities: missing, supported, reason, disposition };
    }),
  };
}

export function classifyValidationExecution(input: {
  plan: ValidationPlanEntry; exitCode: number | null; signal?: string | null; timedOut?: boolean;
  cancelled?: boolean; spawnError?: boolean; stdout?: string; stderr?: string;
}): ValidationOutcomeRecord {
  const base = { command: input.plan.command, acceptance: input.plan.acceptance, exitCode: input.exitCode, evidenceRole: input.plan.evidenceRole };
  if (input.plan.disposition === "capability_unsupported") return { ...base, outcome: "capability_unsupported", reason: input.plan.reason };
  if (input.plan.disposition === "skipped_by_policy") return { ...base, outcome: "skipped_by_policy", reason: input.plan.reason };
  if (input.cancelled) return { ...base, outcome: "cancelled", reason: "Validation was cancelled." };
  if (input.timedOut) return { ...base, outcome: "timed_out", reason: "Validation exceeded its timeout." };
  if (input.spawnError) return { ...base, outcome: "runtime_failed", reason: "Validation process could not be started." };
  if (input.signal) return { ...base, outcome: "runtime_failed", reason: `Validation process terminated by ${input.signal}.` };
  if (input.exitCode === 0) return { ...base, outcome: "passed", reason: null };
  const output = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  if (/(?:cannot find (?:module|package)|module_not_found|command not found|enoent|missing dependency|node_modules)/i.test(output)) {
    return { ...base, outcome: "setup_failed", reason: "A required command or dependency is unavailable." };
  }
  return { ...base, outcome: "product_failed", reason: `Validation exited with code ${input.exitCode ?? "unknown"}.` };
}

export function aggregateValidationOutcomes(outcomes: readonly ValidationOutcomeRecord[]): ValidationAggregateStatus {
  const relevant = outcomes.filter((item) => item.acceptance === "required");
  const has = (outcome: ValidationCommandOutcome) => relevant.some((item) => item.outcome === outcome);
  if (has("cancelled")) return "cancelled";
  if (has("timed_out")) return "timed_out";
  if (has("runtime_failed")) return "runtime_failed";
  if (has("setup_failed")) return "setup_failed";
  if (has("product_failed")) return "product_failed";
  if (has("capability_unsupported")) return "blocked_by_capability";
  if (has("skipped_by_policy")) return "blocked_by_policy";
  return outcomes.some((item) => item.outcome !== "passed") ? "completed_with_validation_gaps" : "passed";
}

export function runtimeCapabilities(input: {
  runtime: "docker" | "local-disposable"; hasGitMetadata: boolean; hasGitHistory?: boolean;
  hasWorkingTreeIndex?: boolean; packageManager?: boolean; dependencies?: boolean; network?: boolean;
  credentials?: boolean; docker?: boolean; providerModel?: boolean; database?: boolean; production?: boolean;
}): ValidationRuntimeCapabilities {
  return {
    runtime: input.runtime,
    lane: input.runtime === "docker" ? "docker-validation" : "local-disposable-validation",
    available: unique([
      "filesystem", "shell", input.runtime,
      ...(input.hasGitMetadata ? ["git-metadata"] as const : []),
      ...(input.hasGitHistory ? ["git-history"] as const : []),
      ...(input.hasWorkingTreeIndex ? ["working-tree-index"] as const : []),
      ...(input.packageManager ? ["package-manager"] as const : []),
      ...(input.dependencies ? ["dependencies"] as const : []),
      ...(input.network ? ["network"] as const : []), ...(input.credentials ? ["credentials"] as const : []),
      ...(input.docker ? ["docker"] as const : []), ...(input.providerModel ? ["provider-model"] as const : []),
      ...(input.database ? ["database"] as const : []), ...(input.production ? ["production"] as const : []),
    ] as ValidationCapability[]),
  };
}

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
