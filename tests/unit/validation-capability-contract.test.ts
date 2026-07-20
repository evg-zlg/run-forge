import { describe, expect, it } from "vitest";
import {
  VALIDATION_CAPABILITIES, aggregateValidationOutcomes, buildValidationPreflightPlan,
  classifyValidationExecution, defaultValidationProfile, normalizeValidationRequirements, runtimeCapabilities,
  type ValidationPlanEntry,
} from "../../src/validation/capability-contract.js";

describe("capability-aware validation contract", () => {
  it("publishes the formal wave-1 capability vocabulary", () => {
    expect(VALIDATION_CAPABILITIES).toEqual([
      "filesystem", "git-metadata", "git-history", "working-tree-index", "package-manager", "dependencies",
      "shell", "network", "credentials", "docker", "local-disposable", "provider-model", "database", "production",
      "git-read-only-evidence",
    ]);
  });

  it("plans Docker Git evidence as unsupported when the workspace has no .git metadata", () => {
    const normalized = normalizeValidationRequirements({ commands: ["git diff --check"], mode: "explicit" });
    const plan = buildValidationPreflightPlan({
      ...normalized, cwd: "/workspace",
      runtime: runtimeCapabilities({ runtime: "docker", hasGitMetadata: false, docker: true }),
    });
    expect(plan.commands[0]).toMatchObject({
      command: "git diff --check", runtime: "docker", lane: "docker-validation", cwd: "/workspace",
      requiredCapabilities: expect.arrayContaining(["git-metadata", "working-tree-index"]),
      availableCapabilities: expect.arrayContaining(["filesystem", "shell", "docker"]),
      supported: false, disposition: "capability_unsupported", acceptance: "evidence-only", evidenceRole: "git-evidence",
    });
  });

  it("preserves completed implementation when optional/advisory validation is unsupported", () => {
    const outcomes = [
      record("corepack pnpm test", "required", "passed"),
      record("docker compose config", "optional", "capability_unsupported"),
      record("unknown advisory", "advisory", "capability_unsupported"),
    ];
    expect(aggregateValidationOutcomes(outcomes)).toBe("completed_with_validation_gaps");
  });

  it("blocks required unsupported validation by capability", () => {
    expect(aggregateValidationOutcomes([record("custom-check", "required", "capability_unsupported")])).toBe("blocked_by_capability");
    expect(aggregateValidationOutcomes([{ ...record("custom-check", "required", "capability_unsupported"), outcome: "skipped_by_policy" }])).toBe("blocked_by_policy");
  });

  it("classifies product exit 1, missing dependency, runtime crash, timeout and cancellation distinctly", () => {
    const plan = executablePlan();
    expect(classifyValidationExecution({ plan, exitCode: 1, stderr: "AssertionError" }).outcome).toBe("product_failed");
    expect(classifyValidationExecution({ plan, exitCode: 1, stderr: "Cannot find module 'vitest'" }).outcome).toBe("setup_failed");
    expect(classifyValidationExecution({ plan, exitCode: null, signal: "SIGSEGV" }).outcome).toBe("runtime_failed");
    expect(classifyValidationExecution({ plan, exitCode: null, timedOut: true }).outcome).toBe("timed_out");
    expect(classifyValidationExecution({ plan, exitCode: null, cancelled: true }).outcome).toBe("cancelled");
  });

  it("never schedules an unsupported unknown command for blind execution", () => {
    const normalized = normalizeValidationRequirements({ commands: ["bespoke-validator --all"], mode: "explicit" });
    const plan = buildValidationPreflightPlan({
      ...normalized, cwd: "/workspace",
      runtime: runtimeCapabilities({ runtime: "local-disposable", hasGitMetadata: true, dependencies: true, packageManager: true }),
    });
    expect(plan.commands[0]).toMatchObject({ supported: false, disposition: "capability_unsupported" });
    expect(classifyValidationExecution({ plan: plan.commands[0]!, exitCode: null }).outcome).toBe("capability_unsupported");
  });

  it("does not schedule a known package command without evidenced runtime capabilities", () => {
    const normalized = normalizeValidationRequirements({ commands: ["corepack pnpm test"], mode: "explicit" });
    const plan = buildValidationPreflightPlan({
      ...normalized, cwd: "/workspace",
      runtime: runtimeCapabilities({ runtime: "local-disposable", hasGitMetadata: true }),
    });
    expect(plan.commands[0]).toMatchObject({
      supported: false, disposition: "capability_unsupported",
      missingCapabilities: expect.arrayContaining(["package-manager", "dependencies"]),
    });
    expect(aggregateValidationOutcomes([
      classifyValidationExecution({ plan: plan.commands[0]!, exitCode: null }),
    ])).toBe("blocked_by_capability");
  });

  it("allows explicit metadata and project policy to extend known-command planning", () => {
    const normalized = normalizeValidationRequirements({
      commands: ["bespoke-validator --all"], mode: "explicit",
      requirements: [{ command: "bespoke-validator --all", capabilities: ["shell", "database"], acceptance: "advisory", evidenceRole: "integration-evidence", fallbacks: ["Attach CI evidence"] }],
      profile: { ...defaultValidationProfile("explicit"), additionalCapabilities: ["filesystem"] },
    });
    const plan = buildValidationPreflightPlan({
      ...normalized, cwd: "/workspace", policy: { deniedCapabilities: ["database"] },
      runtime: { runtime: "local-disposable", lane: "test", available: ["filesystem", "shell", "database", "local-disposable"] },
    });
    expect(plan.commands[0]).toMatchObject({
      source: "explicit", acceptance: "advisory", evidenceRole: "integration-evidence", fallbacks: ["Attach CI evidence"],
      disposition: "skipped_by_policy", supported: false,
    });
  });
});

function executablePlan(): ValidationPlanEntry {
  return {
    command: "corepack pnpm test", requiredCapabilities: ["filesystem", "shell", "package-manager", "dependencies"],
    acceptance: "required", evidenceRole: "product-validation", fallbacks: [], source: "known-command",
    runtime: "local-disposable", lane: "test", cwd: "/workspace",
    availableCapabilities: ["filesystem", "shell", "package-manager", "dependencies", "local-disposable"],
    missingCapabilities: [], supported: true, reason: "available", disposition: "execute",
  };
}

function record(command: string, acceptance: "required" | "optional" | "advisory" | "evidence-only", outcome: "passed" | "capability_unsupported") {
  return { command, acceptance, outcome, exitCode: outcome === "passed" ? 0 : null, reason: null, evidenceRole: "test" } as const;
}
