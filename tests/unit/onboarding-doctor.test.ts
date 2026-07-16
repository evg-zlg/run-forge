import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildDoctorReport } from "../../src/product/doctor.js";
import { buildOnboardingReport, renderOnboarding } from "../../src/product/onboarding.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("onboarding and doctor contracts", () => {
  it("returns compact versioned onboarding JSON without environment secrets", async () => {
    const report = await buildOnboardingReport({});
    expect(report).toMatchObject({ schemaVersion: 1, product: "RunForge", transport: "local-cli", entrypoint: "runforge" });
    expect(report.commands.submitTask).toContain("task-run start --spec");
    expect(report.installation.root).toContain("RunForge-worktrees/onboarding-1");
    expect(report.unsupportedInterfaces).toContain("HTTP API");
    expect(renderOnboarding(report)).toContain("only when results.json reports awaiting_owner_decision");
    expect(JSON.stringify(report)).not.toMatch(/(ghp_|BEGIN PRIVATE KEY|password)/i);
  });

  it("reports a dirty target as ready with warnings and keeps artifacts outside", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "dirty.txt"), "preserve\n");
    const report = await buildDoctorReport({ repo });
    expect(report.status).toBe("ready_with_warnings");
    expect(report.targetRepository?.worktree.clean).toBe(false);
    expect(report.artifactRoot.outsideTargetRepository).toBe(true);
    expect(report.checks.find((item) => item.id === "target_worktree")?.status).toBe("warning");
    expect(report.checks.find((item) => item.id === "github")?.status).toBe("not_required");
  });

  it("blocks missing paths, non-Git paths, and artifact roots inside targets", async () => {
    const missing = await buildDoctorReport({ repo: join(tmpdir(), `missing-${Date.now()}`) });
    expect(missing.status).toBe("blocked");
    const plain = temp(await mkdtemp(join(tmpdir(), "runforge-plain-")));
    expect((await buildDoctorReport({ repo: plain })).status).toBe("blocked");
    const repo = await gitRepo();
    const unsafe = await buildDoctorReport({ repo, artifactRoot: join(repo, "artifacts") });
    expect(unsafe.status).toBe("blocked");
    expect(unsafe.checks.find((item) => item.id === "artifact_root")?.status).toBe("blocked");
  });

  it("writes RUNFORGE.md only when explicit and refuses overwrite", async () => {
    const repo = await gitRepo();
    const readonly = await buildOnboardingReport({ repo });
    expect(readonly.projectFile.written).toBe(false);
    const written = await buildOnboardingReport({ repo, writeProjectFile: true });
    expect(written.projectFile.written).toBe(true);
    expect(await readFile(join(repo, "RUNFORGE.md"), "utf8")).toContain("project-specific defaults only");
    await expect(buildOnboardingReport({ repo, writeProjectFile: true })).rejects.toThrow("Refusing to overwrite");
  });

  it("shell-quotes target paths in generated commands", async () => {
    const repo = await gitRepo("runforge project;safe-");
    const report = await buildOnboardingReport({ repo });
    expect(report.commands.doctor).toContain(`--repo '${report.targetRepository?.path}'`);
    expect(report.nextAction.command).toBe(report.commands.doctor);
  });

  it("blocks Git repositories without a committed HEAD", async () => {
    const repo = temp(await mkdtemp(join(tmpdir(), "runforge-unborn-")));
    await execFileAsync("git", ["init", "-b", "main", repo]);
    const report = await buildDoctorReport({ repo });
    expect(report.status).toBe("blocked");
    expect(report.checks.find((item) => item.id === "target_head")?.status).toBe("blocked");
  });

  it("treats detached HEAD and missing package metadata as warnings", async () => {
    const repo = await gitRepo();
    await execFileAsync("git", ["-C", repo, "checkout", "--detach"]);
    const detached = await buildDoctorReport({ repo });
    expect(detached.status).toBe("ready_with_warnings");
    expect(detached.targetRepository?.detachedHead).toBe(true);
    expect(detached.checks.find((item) => item.id === "target_branch")?.status).toBe("warning");

    const bareProject = temp(await mkdtemp(join(tmpdir(), "runforge-no-package-")));
    await execFileAsync("git", ["init", "-b", "main", bareProject]);
    await writeFile(join(bareProject, "README.md"), "# Project\n");
    await execFileAsync("git", ["-C", bareProject, "add", "."]);
    await execFileAsync("git", ["-C", bareProject, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    const missingPackage = await buildDoctorReport({ repo: bareProject });
    expect(missingPackage.checks.find((item) => item.id === "package_manager")?.status).toBe("warning");
  });

  it("blocks optional integrations only when explicitly requested", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const base = await buildDoctorReport({});
      expect(base.checks.find((item) => item.id === "github")?.status).toBe("not_required");
      const requested = await buildDoctorReport({ runtime: "docker", publication: "draft-pr" });
      expect(requested.checks.find((item) => item.id === "docker")?.status).toBe("blocked");
      expect(requested.checks.find((item) => item.id === "github")?.status).toBe("blocked");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

async function gitRepo(prefix = "runforge-project-"): Promise<string> {
  const repo = temp(await mkdtemp(join(tmpdir(), prefix)));
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node -e \"\"" } }));
  await writeFile(join(repo, "package-lock.json"), "{}\n");
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return repo;
}

function temp(path: string): string { roots.push(path); return path; }
