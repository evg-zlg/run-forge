import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdminUi } from "../../src/admin/builder.js";
import { diffAdminConfigs, saveAdminConfigDraft, validateAdminConfigDraft } from "../../src/admin/config-edit.js";
import { loadAdminConfig, writeAdminConfig, type AdminConfig } from "../../src/admin/config.js";
import { redactSecrets } from "../../src/admin/redaction.js";
import { buildRunDetail } from "../../src/admin/run-graph.js";
import { startAdminServer } from "../../src/admin/server.js";

const originalOpenRouter = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouter;
});

describe("admin UI alpha", () => {
  it("loads safe defaults when config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-admin-missing-"));
    const loaded = await loadAdminConfig(join(root, "missing.json"));

    expect(loaded.exists).toBe(false);
    expect(loaded.config.schemaVersion).toBe("admin-alpha");
    expect(loaded.config.providers.find((provider) => provider.id === "openrouter")?.apiKeyRef).toBe("env:OPENROUTER_API_KEY");
    expect(loaded.config.runs.defaultRoots).toEqual(["validation/runs"]);
  });

  it("loads configured repos and providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "runforge-admin-config-"));
    const configPath = join(root, "config.json");
    await writeAdminConfig(configPath, config(root));

    const loaded = await loadAdminConfig(configPath);

    expect(loaded.exists).toBe(true);
    expect(loaded.config.repositories[0]).toMatchObject({ id: "fixture", name: "Fixture" });
    expect(loaded.config.providers[0]).toMatchObject({ id: "openrouter", type: "openrouter" });
  });

  it("reports env token presence without exposing the value", async () => {
    const root = await createFixtureRoot();
    const configPath = join(root, "config.json");
    const fakeOpenRouterKey = `sk-${"or"}-v1-this-secret-token-should-never-render`;
    process.env.OPENROUTER_API_KEY = fakeOpenRouterKey;
    await writeAdminConfig(configPath, config(root));

    const result = await buildAdminUi({ repoRoot: root, config: configPath, out: join(root, "admin") });
    const html = await readFile(result.indexPath, "utf8");

    expect(result.data.providers[0]?.tokenStatus).toBe("present");
    expect(html).toContain("env:OPENROUTER_API_KEY");
    expect(html).not.toContain(fakeOpenRouterKey);
  });

  it("redacts token-like values", () => {
    const bearerValue = "abcdefghijklmnopqrstuvwxyz";
    const openRouterKey = `sk-${"or"}-v1-abcdefghiabcdefghi`;
    const redacted = redactSecrets([
      `Authorization: Bearer ${bearerValue}`,
      `OPENROUTER_API_KEY=${openRouterKey}`,
      "token=plain-secret-value"
    ].join("\n"));

    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("OPENROUTER_API_KEY=[REDACTED]");
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).not.toContain(bearerValue);
    expect(redacted).not.toContain(openRouterKey);
    expect(redacted).not.toContain("plain-secret-value");
  });

  it("loads run index data, graph details, and overview counts", async () => {
    const root = await createFixtureRoot();
    const configPath = join(root, "config.json");
    await writeAdminConfig(configPath, config(root));

    const result = await buildAdminUi({ repoRoot: root, config: configPath, out: join(root, "admin") });

    expect(result.data.runs).toHaveLength(1);
    expect(result.data.runs[0]).toMatchObject({
      alpha: "ALPHA-UI",
      outcome: "provider_rejected",
      providerStatus: "rejected",
      doNotApply: true
    });
    expect(result.data.overview.byOutcome.provider_rejected).toBe(1);
    expect(result.data.overview.urgentSafetyCounts.provider_rejected).toBe(1);
    expect(result.data.runDetails[0]?.graph.map((node) => node.label)).toEqual(["task_received", "provider_patch_validator", "packet_writer"]);
  });

  it("builds run detail graph from events.jsonl", async () => {
    const root = await createFixtureRoot();
    const detail = await buildRunDetail(join(root, "validation/runs/ALPHA-UI/reject/packet"));

    expect(detail.graph).toHaveLength(3);
    expect(detail.summary).toContain("external_code_proposal");
    expect(detail.providerAudit).toMatchObject({ verdict: "rejected" });
  });

  it("renders missing repo paths as missing and writes static output", async () => {
    const root = await createFixtureRoot();
    const configPath = join(root, "config.json");
    await writeAdminConfig(configPath, {
      ...config(root),
      repositories: [{
        id: "missing",
        name: "Missing",
        path: join(root, "does-not-exist"),
        tags: []
      }]
    });

    const result = await buildAdminUi({ repoRoot: root, config: configPath, out: join(root, "admin") });
    const html = await readFile(result.indexPath, "utf8");

    expect(result.data.repositories[0]).toMatchObject({ exists: false, gitStatus: "missing" });
    expect(html).toContain("Local Operator Console");
    expect(html).toContain("RunForge path");
    expect(html).toContain("RunForge SHA");
    expect(html).toContain("Config path");
    expect(html).toContain("Runs / Evidence");
    expect(html).toContain('id="repo-filter"');
    expect(html).toContain("Run Detail / Graph");
    expect(html).toContain("Settings");
    expect(html).toContain("Config path");
    expect(html).toContain("repo-editor");
  });

  it("validates repository add/edit/remove draft operations", async () => {
    const root = await createFixtureRoot();
    const draft = config(root);
    draft.repositories.push({ id: "factory", name: "Factory", path: join(root, "factory"), tags: ["external"] });
    draft.repositories[0] = { ...draft.repositories[0]!, name: "Fixture edited" };
    draft.repositories = draft.repositories.filter((repo) => repo.id !== "factory");

    const result = await validateAdminConfigDraft(draft, root);

    expect(result.ok).toBe(true);
    expect(result.normalized.repositories).toHaveLength(1);
    expect(result.normalized.repositories[0]?.name).toBe("Fixture edited");
  });

  it("returns an error for duplicate repository ids", async () => {
    const root = await createFixtureRoot();
    const draft = {
      ...config(root),
      repositories: [
        { id: "dupe", name: "One", path: root, tags: [] },
        { id: "dupe", name: "Two", path: join(root, "fixture-repo"), tags: [] }
      ]
    };

    const result = await validateAdminConfigDraft(draft, root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate_repository_id")).toBe(true);
  });

  it("reports missing repo paths as warnings, not crashes", async () => {
    const root = await createFixtureRoot();
    const result = await validateAdminConfigDraft({
      ...config(root),
      repositories: [{ id: "missing", name: "Missing", path: join(root, "missing"), tags: [] }]
    }, root);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", code: "repository_path_missing" }));
  });

  it("validates provider add/edit/remove draft operations", async () => {
    const root = await createFixtureRoot();
    const draft = config(root);
    draft.providers.push({ id: "codex", type: "cli", enabled: false, command: "codex" });
    draft.providers[0] = { ...draft.providers[0]!, defaultModel: "openai/gpt-test" };
    draft.providers = draft.providers.filter((provider) => provider.id !== "codex");

    const result = await validateAdminConfigDraft(draft, root);

    expect(result.ok).toBe(true);
    expect(result.normalized.providers).toHaveLength(1);
    expect(result.normalized.providers[0]?.defaultModel).toBe("openai/gpt-test");
  });

  it("rejects raw OpenRouter keys in apiKeyRef", async () => {
    const root = await createFixtureRoot();
    const rawKey = `sk-${"or"}-v1-abcdefghiabcdefghi`;
    const result = await validateAdminConfigDraft({
      ...config(root),
      providers: [{ id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: rawKey }]
    }, root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "provider_raw_token_rejected" }));
  });

  it("redacts token-like values in diff preview", () => {
    const root = "/tmp/runforge-admin-test";
    const rawKey = `sk-${"or"}-v1-abcdefghiabcdefghi`;
    const diff = diffAdminConfigs(config(root), {
      ...config(root),
      providers: [{ id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: rawKey }]
    });

    expect(diff.json).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(diff.json).not.toContain(rawKey);
  });

  it("saves only the configured admin config path and creates a bounded backup", async () => {
    const root = await createFixtureRoot();
    const realConfig = join(root, "real-config.json");
    const draftPath = join(root, "draft.json");
    await writeAdminConfig(realConfig, config(root));
    const draft = {
      ...config(root),
      repositories: [{ id: "edited", name: "Edited", path: root, tags: [] }]
    };
    await writeFile(draftPath, JSON.stringify(draft), "utf8");

    const result = await saveAdminConfigDraft({ configPath: realConfig, draft, repoRoot: root });
    const loaded = await loadAdminConfig(realConfig);

    expect(result.saved).toBe(true);
    expect(result.configPath).toBe(realConfig);
    expect(result.backupPath).toBe(`${realConfig}.bak`);
    await expect(stat(`${realConfig}.bak`)).resolves.toBeTruthy();
    expect(loaded.config.repositories[0]?.id).toBe("edited");
    expect(await readFile(draftPath, "utf8")).toContain("edited");
  });

  it("validates run roots add/edit/remove and duplicate warnings", async () => {
    const root = await createFixtureRoot();
    const draft = config(root);
    draft.runs.defaultRoots.push("validation/runs");
    draft.runs.defaultRoots[0] = "validation/runs/ALPHA-UI";

    const result = await validateAdminConfigDraft(draft, root);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate_run_root")).toBe(false);
    draft.runs.defaultRoots.push("validation/runs/ALPHA-UI");
    const duplicate = await validateAdminConfigDraft(draft, root);
    expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", code: "duplicate_run_root" }));
  });

  it("localhost server rejects invalid config saves and never exposes env values", async () => {
    const root = await createFixtureRoot();
    const configPath = join(root, "config.json");
    const fakeOpenRouterKey = `sk-${"or"}-v1-server-secret-should-not-render`;
    process.env.OPENROUTER_API_KEY = fakeOpenRouterKey;
    await writeAdminConfig(configPath, config(root));
    const instance = await startAdminServer({ config: configPath, repoRoot: root, out: join(root, "admin"), port: 0 });
    try {
      const invalid = await fetch(new URL("/api/admin/config/save", instance.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: { ...config(root), providers: [{ id: "openrouter", type: "openrouter", apiKeyRef: fakeOpenRouterKey }] } })
      });
      const body = await invalid.text();

      expect(invalid.status).toBe(422);
      expect(body).toContain("provider_raw_token_rejected");
      expect(body).not.toContain(fakeOpenRouterKey);

      const status = await fetch(new URL("/api/admin/status", instance.url)).then((response) => response.json()) as { providerCalls: boolean; repoMutation: boolean };
      expect(status.providerCalls).toBe(false);
      expect(status.repoMutation).toBe(false);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runforge-admin-fixture-"));
  const packet = join(root, "validation/runs/ALPHA-UI/reject/packet");
  await mkdir(packet, { recursive: true });
  await writeFile(join(packet, "run.json"), JSON.stringify({
    schemaVersion: "alpha-test",
    runId: "admin-fixture",
    taskType: "external_code_proposal",
    status: "provider_rejected",
    repo: {
      path: join(root, "fixture-repo"),
      mutationVerdict: "unchanged",
      headBefore: "abc",
      headAfter: "abc"
    }
  }), "utf8");
  await writeFile(join(packet, "proposal-status.json"), JSON.stringify({
    outcome: "provider_rejected",
    providerStatus: "rejected",
    reviewerDecision: "do_not_apply",
    diagnostics: ["forbidden path"]
  }), "utf8");
  await writeFile(join(packet, "events.jsonl"), [
    JSON.stringify({ type: "task_received", status: "ok" }),
    JSON.stringify({ type: "provider_patch_validator", status: "rejected" }),
    JSON.stringify({ type: "packet_writer", status: "ok" })
  ].join("\n"), "utf8");
  await writeFile(join(packet, "packet-manifest.json"), JSON.stringify({
    schemaVersion: "alpha-test",
    runId: "admin-fixture",
    artifacts: [{ path: "run.json" }, { path: "proposal-status.json" }]
  }), "utf8");
  await writeFile(join(packet, "metrics.json"), JSON.stringify({ durationMs: 42 }), "utf8");
  await writeFile(join(packet, "safety-report.json"), JSON.stringify({ mutationVerdict: "unchanged" }), "utf8");
  await writeFile(join(packet, "provider-safety-report.json"), JSON.stringify({ verdict: "rejected" }), "utf8");
  await mkdir(join(root, "fixture-repo"), { recursive: true });
  return root;
}

function config(root: string): AdminConfig {
  return {
    schemaVersion: "admin-alpha",
    repositories: [{
      id: "fixture",
      name: "Fixture",
      path: join(root, "fixture-repo"),
      tags: ["test"]
    }],
    providers: [{
      id: "openrouter",
      type: "openrouter",
      enabled: false,
      apiKeyRef: "env:OPENROUTER_API_KEY",
      defaultModel: null
    }],
    runs: {
      defaultRoots: ["validation/runs"]
    }
  };
}
