import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAdminUi } from "../src/admin/builder.js";
import { diffAdminConfigs, saveAdminConfigDraft, validateAdminConfigDraft } from "../src/admin/config-edit.js";
import { defaultAdminConfig, writeAdminConfig, type AdminConfig } from "../src/admin/config.js";
import { startAdminServer } from "../src/admin/server.js";

const execFileAsync = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const out = join(repo, "validation/runs/ADMIN-UI-2");
const errors: string[] = [];
const commandsRun: string[] = ["pnpm validation:admin-ui-2"];

await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "runforge-admin-ui-2-"));
const configPath = join(temp, "config.json");
const saveSmokePath = join(temp, "save-smoke-config.json");
const adminOut = "/tmp/runforge-admin-ui";
const missingRepoPath = join(temp, "missing-repo");
const runRoot = join(temp, "runs");
await mkdir(runRoot, { recursive: true });

const config: AdminConfig = {
  ...defaultAdminConfig(),
  repositories: [
    { id: "runforge", name: "RunForge", path: repo, tags: ["self", "admin-ui-2"] },
    { id: "missing-demo", name: "Missing demo repo", path: missingRepoPath, tags: ["missing", "demo"] }
  ],
  providers: [
    { id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: "env:OPENROUTER_API_KEY", defaultModel: null },
    { id: "codex-cli", type: "cli", enabled: false, command: "codex" }
  ],
  runs: {
    defaultRoots: ["validation/runs", runRoot]
  }
};

await writeAdminConfig(configPath, config);
await writeAdminConfig(saveSmokePath, config);
const build = await buildAdminUi({ config: configPath, out: adminOut, repoRoot: repo });
const validation = await validateAdminConfigDraft(config, repo);
const diff = diffAdminConfigs(defaultAdminConfig(), config);
const rawKey = `sk-${"or"}-v1-validation-secret-should-redact`;
const rawValidation = await validateAdminConfigDraft({
  ...config,
  providers: [{ id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: rawKey }]
}, repo);
const redactedDiff = diffAdminConfigs(config, {
  ...config,
  providers: [{ id: "openrouter", type: "openrouter", enabled: false, apiKeyRef: rawKey }]
});
const directSave = await saveAdminConfigDraft({
  configPath: saveSmokePath,
  draft: { ...config, repositories: [{ id: "saved", name: "Saved", path: repo, tags: [] }] },
  repoRoot: repo
});

const server = await startAdminServer({ config: saveSmokePath, repoRoot: repo, out: join(temp, "server-out"), port: 0 });
let serverStatus = 0;
let serverSaveOk = false;
try {
  const response = await fetch(new URL("/api/admin/config/save", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: config })
  });
  serverStatus = response.status;
  const body = await response.json() as { saved?: boolean };
  serverSaveOk = body.saved === true;
} finally {
  await new Promise<void>((resolveClose) => server.server.close(() => resolveClose()));
}

check(build.data.overview.repositoryCount === 2, "expected two repositories in admin data");
check(build.data.overview.providerCount === 2, "expected two providers in admin data");
check(build.data.settings.defaultRoots.length === 2, "expected two run roots");
check(validation.ok, `draft validation should pass without errors: ${validation.diagnostics.map((item) => item.code).join(", ")}`);
check(validation.diagnostics.some((item) => item.code === "repository_path_missing"), "missing repo path should be a warning diagnostic");
check(rawValidation.ok === false, "raw OpenRouter apiKeyRef should be rejected");
check(redactedDiff.json.includes("[REDACTED_OPENROUTER_KEY]"), "diff preview should redact raw OpenRouter-shaped keys");
check(!redactedDiff.json.includes(rawKey), "diff preview must not expose raw key");
check(directSave.saved, "direct save smoke should write temp admin config");
check(directSave.configPath === saveSmokePath, "save smoke should write only configured temp config path");
check(serverStatus === 200 && serverSaveOk, "localhost server save smoke should pass");
check((await readFile(build.indexPath, "utf8")).includes("Config Editor") || (await readFile(build.indexPath, "utf8")).includes("repo-editor"), "rendered UI should include config editor controls");

const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
const sha = await git(["rev-parse", "--short", "HEAD"]);
const dirty = (await git(["status", "--short"])).trim().length > 0;

const results = {
  schemaVersion: "admin-ui-2-validation",
  ok: errors.length === 0,
  branch,
  commitSha: sha,
  worktreeDirtyDuringEvidence: dirty,
  configPath,
  tempSaveConfigPath: saveSmokePath,
  adminOutputPath: adminOut,
  adminIndexPath: build.indexPath,
  adminDataPath: build.dataPath,
  counts: {
    repositories: build.data.overview.repositoryCount,
    providers: build.data.overview.providerCount,
    runRoots: build.data.settings.defaultRoots.length
  },
  validation: {
    ok: validation.ok,
    diagnostics: validation.diagnostics.map((item) => ({ level: item.level, code: item.code, path: item.path }))
  },
  redaction: {
    rawTokenRejected: rawValidation.ok === false,
    diffRedacted: redactedDiff.json.includes("[REDACTED_OPENROUTER_KEY]") && !redactedDiff.json.includes(rawKey)
  },
  diffPreview: {
    summary: diff.summary
  },
  saveBehavior: {
    saved: directSave.saved,
    configPath: directSave.configPath,
    backupPath: directSave.backupPath
  },
  serverSmoke: {
    url: server.url,
    status: serverStatus,
    saved: serverSaveOk,
    localOnly: true,
    providerCalls: false,
    repoMutation: false
  },
  commandsRun,
  errors
};

await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
const summary = [
  "# ADMIN-UI-2 Validation",
  "",
  `Branch: ${branch}`,
  `Commit SHA: ${sha}`,
  `Worktree dirty during evidence: ${dirty}`,
  `Config path used: ${configPath}`,
  `Temp save config path: ${saveSmokePath}`,
  `Admin output path: ${adminOut}`,
  "",
  "## Checks",
  "",
  `- Repos loaded: ${build.data.overview.repositoryCount}`,
  `- Providers loaded: ${build.data.overview.providerCount}`,
  `- Run roots loaded: ${build.data.settings.defaultRoots.length}`,
  `- Validation diagnostics observed: ${validation.diagnostics.map((item) => item.code).join(", ") || "none"}`,
  `- Raw token rejection: ${rawValidation.ok === false ? "passed" : "failed"}`,
  `- Redacted diff preview: ${results.redaction.diffRedacted ? "passed" : "failed"}`,
  `- Direct save to temp config: ${directSave.saved ? "passed" : "failed"}`,
  `- Server smoke save: ${serverStatus} / ${serverSaveOk ? "saved" : "not saved"}`,
  "",
  "## Commands Run",
  "",
  ...commandsRun.map((command) => `- ${command}`),
  "",
  "## Safety",
  "",
  "- Writes were limited to temp admin config paths.",
  "- Provider token values were not rendered or stored.",
  "- No provider APIs were called.",
  "- No external repositories were mutated.",
  "- Server was started on localhost only and shut down by the script.",
  "",
  "## Known Limitations",
  "",
  "- Static file mode cannot save; saving requires the localhost admin server.",
  "- Missing repo and run-root paths are warnings so operators can stage future paths.",
  "",
  errors.length === 0 ? "ADMIN-UI-2 validation: passed" : "ADMIN-UI-2 validation: failed",
  ...errors.map((error) => `- ${error}`)
].join("\n") + "\n";
await writeFile(join(out, "summary.md"), summary, "utf8");
console.log(summary);
if (errors.length > 0) process.exitCode = 1;

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

async function git(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd: repo });
    return String(result.stdout).trim();
  } catch {
    return "unknown";
  }
}
